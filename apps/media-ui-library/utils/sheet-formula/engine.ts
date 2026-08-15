/**
 * Evaluador de la hoja: recorre la grilla, calcula las celdas que empiezan con
 * `=` y devuelve **sólo lo que hay que pintar**. El archivo nunca guarda un
 * valor calculado; la fórmula es la única fuente de verdad y el resultado se
 * recalcula en el cliente (o se lee de la caché del servidor).
 *
 * Tres cosas lo mantienen acotado:
 *  - memoización por celda y detección de ciclos (`#CIRC!`),
 *  - topes duros de rango y de derrame (`#LIMIT!`),
 *  - un presupuesto global de celdas por corrida.
 *
 * El derrame (`SORT`, `FILTER`, `GROUPBY`, …) es virtual: ocupa las celdas de
 * abajo/derecha sin escribirlas. Se hacen dos pasadas para que una fórmula que
 * vive *arriba* de un derrame también vea sus valores; con dos alcanza y el
 * costo queda acotado.
 */

import { parseFormula, ParseError, type Node } from "./parser.js";
import { cellKey, refLabel } from "./refs.js";
import { fail, isError, type Arg, type CallCtx, type EvalLimits, type FormulaValue, type Scalar } from "./types.js";
import { coerceText, compareValues, formatValue, looseEquals, toNumber, toText } from "./values.js";
import { findFunction } from "./functions/index.js";

export const DEFAULT_LIMITS: EvalLimits = {
	maxRangeCells: 200_000,
	maxSpillRows: 5_000,
	maxSpillCols: 64,
};

/** Presupuesto total de celdas leídas por corrida: el techo de una hoja patológica. */
const CELL_BUDGET = 2_000_000;
/** Profundidad de anidado de referencias (una cadena más larga que esto es un error de diseño). */
const MAX_DEPTH = 64;
/** Cierre de dependencias más grande que esto no se cachea: hashearlo cuesta más que recalcular. */
const MAX_CACHEABLE_DEPS = 2_048;
/** Tope del resumen de referencias que viaja en cada entrada de la caché. */
const DEPS_TEXT_LIMIT = 120;

/** Qué mostrar en una celda que el usuario no escribió como texto plano. */
export interface ComputedCell {
	/** Texto ya formateado, listo para pintar. */
	text: string;
	/** `formula` = la celda tiene el `=`; `spill` = la llenó el derrame de otra. */
	kind: "formula" | "spill";
	/** Marca de error para el estilo (y para no cachearla). */
	error: boolean;
}

/** Entrada de la caché de cálculos: la celda, su fórmula, de qué depende y el valor. */
export interface CalcCacheEntry {
	/** Referencia A1 de la celda. */
	ref: string;
	/** Hash de la fórmula más el texto crudo de su cierre de dependencias completo. */
	hash: string;
	/** Valor ya formateado. */
	value: string;
	/** Referencias de las que depende, en texto (`"A1:A20,C3"`): la caché se explica sola. */
	deps: string;
}

export interface SheetComputation {
	/** Celdas a pintar distinto del texto crudo (fórmulas y derrames). */
	cells: Map<string, ComputedCell>;
	/** Entradas cacheables de esta corrida. */
	entries: CalcCacheEntry[];
	/** Hash del contenido completo: si no cambió, la caché entera sigue válida. */
	docHash: string;
	/** Fórmulas que hubo que evaluar (las demás salieron de la caché). */
	evaluated: number;
	/** Fórmulas servidas desde la caché. */
	reused: number;
}

export interface ComputeOptions {
	/** Caché del servidor de una corrida anterior. */
	cache?: { docHash: string; entries: CalcCacheEntry[] };
	limits?: EvalLimits;
	/** Reloj inyectable (`TODAY()`/`NOW()`); por defecto, el del sistema. */
	now?: () => Date;
}

export function isFormula(raw: string): boolean {
	return raw.startsWith("=") && raw.length > 1;
}

/** Hash FNV-1a de 32 bits en hexadecimal: barato y suficiente para invalidar una caché. */
function hashOf(parts: Iterable<string>): string {
	let hash = 0x81_1c_9d_c5;
	for (const part of parts) {
		for (let i = 0; i < part.length; i++) {
			hash ^= part.codePointAt(i)!;
			hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
		}
		hash ^= 0xff;
		hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

interface SpillArea {
	anchor: string;
	rows: number;
	cols: number;
	data: Scalar[][];
}

class SheetEvaluator {
	readonly #grid: readonly string[][];
	readonly #rows: number;
	readonly #cols: number;
	readonly #limits: EvalLimits;
	readonly #now: () => Date;

	/** AST por celda (o el error de parseo), memoizado: se parsea una sola vez. */
	readonly #asts = new Map<string, Node | ParseError>();
	/** Valor final por celda con fórmula. */
	readonly #values = new Map<string, Scalar>();
	/** Celdas que están siendo evaluadas: si se vuelve a entrar, hay ciclo. */
	readonly #visiting = new Set<string>();
	/** Derrames vigentes: celda ocupada → valor que le toca. */
	#spilled = new Map<string, Scalar>();
	/** Anclas que derramaron en la pasada anterior (para detectar convergencia). */
	#spillAreas: SpillArea[] = [];
	/** Matrices devueltas por las funciones de derrame, por celda ancla. */
	readonly #spillData = new Map<string, Scalar[][]>();
	/** Cierre de dependencias ya calculado por celda (`null` = no cacheable). */
	readonly #closures = new Map<string, { cells: string[]; ranges: string[] } | null>();
	/** Fórmulas cuyo resultado no se puede cachear (volátiles o dentro de un ciclo). */
	readonly #uncacheable = new Set<string>();
	#budget = CELL_BUDGET;

	constructor(grid: readonly string[][], limits: EvalLimits, now: () => Date) {
		this.#grid = grid;
		this.#rows = grid.length;
		this.#cols = grid.reduce((max, row) => Math.max(max, row.length), 0);
		this.#limits = limits;
		this.#now = now;
	}

	raw(r: number, c: number): string {
		return this.#grid[r]?.[c] ?? "";
	}

	/** Recorre la grilla entera evaluando cada fórmula (memoizada). */
	#pass(): void {
		this.#values.clear();
		this.#visiting.clear();
		this.#uncacheable.clear();
		this.#budget = CELL_BUDGET;
		for (let r = 0; r < this.#rows; r++) {
			for (let c = 0; c < this.#cols; c++) {
				if (isFormula(this.raw(r, c))) this.#evaluateCell(r, c, 0);
			}
		}
	}

	/**
	 * Dos pasadas: la primera descubre los derrames y la segunda deja que las
	 * fórmulas que están por encima de un derrame también lo vean. Si la segunda
	 * produce el mismo mapa de derrames (el caso normal), no hay una tercera.
	 */
	run(): void {
		this.#pass();
		const first = this.#collectSpills();
		if (first.length === 0) return;
		this.#spilled = spillMap(first);
		this.#spillAreas = first;
		this.#pass();
		const second = this.#collectSpills();
		this.#spilled = spillMap(second);
		this.#spillAreas = second;
	}

	/** Áreas derramadas de la pasada actual, ya validadas contra las celdas ocupadas. */
	#collectSpills(): SpillArea[] {
		const areas: SpillArea[] = [];
		for (const [key, value] of this.#values) {
			const area = this.#spillOf(key, value);
			if (area) areas.push(area);
		}
		return areas;
	}

	#spillOf(key: string, value: Scalar): SpillArea | null {
		const matrix = this.#spillData.get(key);
		if (!matrix || isError(value)) return null;
		const rows = matrix.length;
		const cols = matrix[0]?.length ?? 0;
		// Una matriz de 1×1 no derrama: entra entera en la celda de la fórmula.
		if (rows <= 1 && cols <= 1) return null;
		return { anchor: key, rows, cols, data: matrix };
	}

	#evaluateCell(r: number, c: number, depth: number): Scalar {
		const key = cellKey(r, c);
		const memo = this.#values.get(key);
		if (memo !== undefined) return memo;
		if (this.#visiting.has(key)) {
			this.#uncacheable.add(key);
			return fail("#CIRC!");
		}
		if (depth > MAX_DEPTH || this.#budget <= 0) return fail("#LIMIT!");

		this.#visiting.add(key);
		const ast = this.#astOf(r, c);
		let value: Scalar;
		if (ast instanceof ParseError) {
			value = fail("#NAME?");
		} else {
			const result = this.#evaluate(ast, { r, c }, depth);
			if (Array.isArray(result)) {
				// Matriz: la esquina queda en la celda y el resto se derrama.
				this.#spillData.set(key, result);
				value = result[0]?.[0] ?? null;
			} else {
				this.#spillData.delete(key);
				value = result;
			}
		}
		this.#visiting.delete(key);
		this.#values.set(key, value);
		return value;
	}

	#astOf(r: number, c: number): Node | ParseError {
		const key = cellKey(r, c);
		const memo = this.#asts.get(key);
		if (memo) return memo;
		let parsed: Node | ParseError;
		try {
			parsed = parseFormula(this.raw(r, c).slice(1));
		} catch (error) {
			parsed = error instanceof ParseError ? error : new ParseError(String(error));
		}
		this.#asts.set(key, parsed);
		return parsed;
	}

	/** Valor de una celda leída como referencia: su fórmula, su derrame o su texto. */
	#read(r: number, c: number, depth: number): Scalar {
		this.#budget--;
		if (r < 0 || c < 0 || r >= this.#rows || c >= this.#cols) return null;
		if (isFormula(this.raw(r, c))) return this.#evaluateCell(r, c, depth + 1);
		const spill = this.#spilled.get(cellKey(r, c));
		if (spill !== undefined) return spill;
		return coerceText(this.raw(r, c));
	}

	#evaluate(node: Node, self: { r: number; c: number }, depth: number): FormulaValue {
		switch (node.t) {
			case "num":
				return node.v;
			case "str":
				return node.v;
			case "bool":
				return node.v;
			case "ref":
				return this.#read(node.r, node.c, depth);
			case "range":
				return fail("#VALUE!"); // Un rango suelto sólo tiene sentido como argumento.
			case "un": {
				const value = toNumber(this.#scalar(node.a, self, depth));
				if (isError(value)) return value;
				return node.op === "-" ? -value : value;
			}
			case "pct": {
				const value = toNumber(this.#scalar(node.a, self, depth));
				return isError(value) ? value : value / 100;
			}
			case "bin":
				return this.#binary(node.op, this.#scalar(node.a, self, depth), this.#scalar(node.b, self, depth));
			case "call":
				return this.#call(node, self, depth);
		}
	}

	/** Evalúa un nodo forzando un escalar (los rangos degradan a su esquina). */
	#scalar(node: Node, self: { r: number; c: number }, depth: number): Scalar {
		if (node.t === "range") {
			const values = this.#rangeValues(node, depth);
			return isError(values) ? values : (values[0]?.[0] ?? null);
		}
		const value = this.#evaluate(node, self, depth);
		return Array.isArray(value) ? (value[0]?.[0] ?? null) : value;
	}

	#binary(op: string, a: Scalar, b: Scalar): Scalar {
		if (isError(a)) return a;
		if (isError(b)) return b;
		if (op === "&") return toText(a) + toText(b);
		if (op === "=" || op === "<>") {
			const equal = looseEquals(a, b);
			return op === "=" ? equal : !equal;
		}
		if (op === "<" || op === ">" || op === "<=" || op === ">=") {
			const cmp = compareValues(a, b);
			if (op === "<") return cmp < 0;
			if (op === ">") return cmp > 0;
			return op === "<=" ? cmp <= 0 : cmp >= 0;
		}
		const left = toNumber(a);
		if (isError(left)) return left;
		const right = toNumber(b);
		if (isError(right)) return right;
		return arithmetic(op, left, right);
	}

	#call(node: Extract<Node, { t: "call" }>, self: { r: number; c: number }, depth: number): FormulaValue {
		const fn = findFunction(node.name);
		if (!fn) return fail("#NAME?");
		if (node.args.length < fn.minArgs || node.args.length > fn.maxArgs) return fail("#VALUE!");

		const args: Arg[] = [];
		for (const argNode of node.args) {
			if (argNode.t === "range") {
				const values = this.#rangeValues(argNode, depth);
				if (isError(values)) return values;
				args.push({ kind: "range", top: argNode.r1, left: argNode.c1, values });
			} else {
				args.push({ kind: "scalar", value: this.#scalar(argNode, self, depth) });
			}
		}
		// Corte por error: salvo que la función pida verlos (IFERROR, ISERROR, IF…).
		if (!fn.acceptsErrors) {
			const error = firstError(args);
			if (error) return error;
		}
		if (fn.volatile) this.#uncacheable.add(cellKey(self.r, self.c));

		const ctx: CallCtx = { limits: this.#limits, self, now: this.#now };
		try {
			return fn.call(args, ctx);
		} catch {
			// Una strategy que se rompe no puede tumbar la hoja entera.
			return fail("#VALUE!");
		}
	}

	/** Materializa un rango. La columna entera (`A:A`) se recorta al alto real. */
	#rangeValues(node: Extract<Node, { t: "range" }>, depth: number): Scalar[][] | ReturnType<typeof fail> {
		const lastRow = node.r2 ?? Math.max(this.#rows - 1, 0);
		const height = lastRow - node.r1 + 1;
		const width = node.c2 - node.c1 + 1;
		if (height <= 0 || width <= 0) return fail("#REF!");
		if (height * width > this.#limits.maxRangeCells) return fail("#LIMIT!");

		const values: Scalar[][] = [];
		for (let r = node.r1; r <= lastRow; r++) {
			const row: Scalar[] = [];
			for (let c = node.c1; c <= node.c2; c++) row.push(this.#read(r, c, depth));
			values.push(row);
		}
		return values;
	}

	// ── Salida ──────────────────────────────────────────────────────────────

	/** Celdas a pintar: primero las fórmulas, después lo que ocupa cada derrame. */
	cells(): Map<string, ComputedCell> {
		const out = new Map<string, ComputedCell>();
		for (const [key, value] of this.#values) {
			out.set(key, { text: formatValue(value), kind: "formula", error: isError(value) });
		}
		for (const area of this.#spillAreas) this.#paintSpill(area, out);
		return out;
	}

	/**
	 * Vuelca un derrame. Si alguna celda de destino ya tiene contenido propio, el
	 * derrame entero se cancela y el ancla queda en `#SPILL!`: pisar datos del
	 * usuario sería peor que no mostrar el resultado.
	 */
	#paintSpill(area: SpillArea, out: Map<string, ComputedCell>): void {
		const [anchorRow, anchorCol] = coords(area.anchor);
		const targets: Array<{ key: string; value: Scalar }> = [];
		for (let dr = 0; dr < area.rows; dr++) {
			for (let dc = 0; dc < area.cols; dc++) {
				if (dr === 0 && dc === 0) continue;
				const r = anchorRow + dr;
				const c = anchorCol + dc;
				const key = cellKey(r, c);
				if (this.raw(r, c) !== "" || out.has(key)) {
					out.set(area.anchor, { text: "#SPILL!", kind: "formula", error: true });
					return;
				}
				targets.push({ key, value: area.data[dr]?.[dc] ?? null });
			}
		}
		for (const target of targets) {
			out.set(target.key, { text: formatValue(target.value), kind: "spill", error: false });
		}
	}

	/** Referencias directas de una fórmula. `null` si supera el tope de dependencias. */
	#directDeps(ast: Node): { cells: string[]; ranges: string[] } | null {
		const cells: string[] = [];
		const ranges: string[] = [];
		const walk = (node: Node): boolean => {
			switch (node.t) {
				case "ref":
					cells.push(cellKey(node.r, node.c));
					return cells.length <= MAX_CACHEABLE_DEPS;
				case "range":
					return this.#walkRange(node, cells, ranges);
				case "un":
				case "pct":
					return walk(node.a);
				case "bin":
					return walk(node.a) && walk(node.b);
				case "call":
					return node.args.every(walk);
				default:
					return true;
			}
		};
		return walk(ast) ? { cells, ranges } : null;
	}

	#walkRange(node: Extract<Node, { t: "range" }>, cells: string[], ranges: string[]): boolean {
		const lastRow = node.r2 ?? Math.max(this.#rows - 1, 0);
		ranges.push(`${refLabel(node.r1, node.c1)}:${refLabel(lastRow, node.c2)}`);
		for (let r = node.r1; r <= lastRow; r++) {
			for (let c = node.c1; c <= node.c2; c++) {
				cells.push(cellKey(r, c));
				if (cells.length > MAX_CACHEABLE_DEPS) return false;
			}
		}
		return true;
	}

	/**
	 * Cierre de dependencias: todas las celdas cuyo texto hace al resultado, las
	 * referenciadas directo y las que traen las fórmulas intermedias. Memoizado y
	 * con detección de ciclos por camino (un rombo A→B,C→D no lo invalida).
	 * `null` = no cacheable (ciclo o demasiadas dependencias).
	 */
	#closure(key: string, path: Set<string>): { cells: string[]; ranges: string[] } | null {
		const memo = this.#closures.get(key);
		if (memo !== undefined) return memo;
		if (path.has(key)) return null;

		const ast = this.#astOf(...coords(key));
		const result = ast instanceof ParseError ? { cells: [], ranges: [] } : this.#expand(key, ast, path);
		this.#closures.set(key, result);
		return result;
	}

	#expand(key: string, ast: Node, path: Set<string>): { cells: string[]; ranges: string[] } | null {
		const direct = this.#directDeps(ast);
		if (!direct) return null;

		path.add(key);
		const all = new Set(direct.cells);
		const ranges = [...direct.ranges];
		for (const dep of direct.cells) {
			if (!isFormula(this.raw(...coords(dep)))) continue;
			const nested = this.#closure(dep, path);
			if (!nested) {
				path.delete(key);
				return null;
			}
			for (const inner of nested.cells) all.add(inner);
			ranges.push(...nested.ranges);
			if (all.size > MAX_CACHEABLE_DEPS) {
				path.delete(key);
				return null;
			}
		}
		path.delete(key);
		return { cells: [...all].sort((a, b) => a.localeCompare(b)), ranges };
	}

	/** Entradas cacheables: fórmulas escalares, deterministas y con pocas dependencias. */
	entries(max: number): CalcCacheEntry[] {
		const candidates: Array<{ entry: CalcCacheEntry; cost: number }> = [];
		for (const [key, value] of this.#values) {
			if (isError(value) || this.#uncacheable.has(key) || this.#spillData.has(key)) continue;
			const closure = this.#closure(key, new Set());
			if (!closure) continue;
			const [r, c] = coords(key);
			candidates.push({
				cost: closure.cells.length,
				entry: {
					ref: refLabel(r, c),
					hash: hashOf([this.raw(r, c), ...closure.cells.map((dep) => this.raw(...coords(dep)))]),
					value: formatValue(value),
					deps: [...new Set(closure.ranges)].join(",").slice(0, DEPS_TEXT_LIMIT),
				},
			});
		}
		// Si no entran todas, quedan las más caras de recalcular.
		candidates.sort((a, b) => b.cost - a.cost);
		return candidates.slice(0, max).map((candidate) => candidate.entry);
	}

	stats(): { evaluated: number } {
		return { evaluated: this.#values.size };
	}
}

/** Clave interna `"r:c"` → par de coordenadas. */
function coords(key: string): [number, number] {
	const separator = key.indexOf(":");
	return [Number(key.slice(0, separator)), Number(key.slice(separator + 1))];
}

function arithmetic(op: string, left: number, right: number): Scalar {
	switch (op) {
		case "+":
			return left + right;
		case "-":
			return left - right;
		case "*":
			return left * right;
		case "/":
			return right === 0 ? fail("#DIV/0!") : left / right;
		case "^": {
			const result = left ** right;
			return Number.isFinite(result) ? result : fail("#NUM!");
		}
		default:
			return fail("#VALUE!");
	}
}

function firstError(args: Arg[]): Scalar | null {
	for (const arg of args) {
		if (arg.kind === "scalar") {
			if (isError(arg.value)) return arg.value;
			continue;
		}
		for (const row of arg.values) {
			for (const value of row) {
				if (isError(value)) return value;
			}
		}
	}
	return null;
}

function spillMap(areas: SpillArea[]): Map<string, Scalar> {
	const map = new Map<string, Scalar>();
	for (const area of areas) {
		const [anchorRow, anchorCol] = coords(area.anchor);
		for (let dr = 0; dr < area.rows; dr++) {
			for (let dc = 0; dc < area.cols; dc++) {
				if (dr === 0 && dc === 0) continue;
				map.set(cellKey(anchorRow + dr, anchorCol + dc), area.data[dr]?.[dc] ?? null);
			}
		}
	}
	return map;
}

/** Hash del contenido completo de la grilla: la llave maestra de la caché. */
export function gridHash(grid: readonly string[][]): string {
	return hashOf(grid.flatMap((row) => [...row, "\n"]));
}

/** Máximo de entradas que se mandan al servidor (el resto se recalcula y listo). */
export const MAX_CACHE_ENTRIES = 400;

/**
 * Calcula la hoja. Con una caché válida (mismo `docHash`) no se evalúa nada: se
 * pintan los valores guardados y recién el próximo cambio dispara el recálculo.
 */
export function computeSheet(grid: readonly string[][], options: ComputeOptions = {}): SheetComputation {
	const docHash = gridHash(grid);
	const cache = options.cache;
	if (cache?.docHash === docHash && cache.entries.length > 0) {
		const cells = cachedCells(grid, cache.entries);
		if (cells) return { cells, entries: cache.entries, docHash, evaluated: 0, reused: cache.entries.length };
	}

	const evaluator = new SheetEvaluator(grid, options.limits ?? DEFAULT_LIMITS, options.now ?? (() => new Date()));
	evaluator.run();
	return {
		cells: evaluator.cells(),
		entries: evaluator.entries(MAX_CACHE_ENTRIES),
		docHash,
		evaluated: evaluator.stats().evaluated,
		reused: 0,
	};
}

/**
 * Pinta la hoja directo desde la caché. Devuelve `null` si la caché no cubre
 * todas las fórmulas de la grilla (entonces hay que evaluar igual): una caché
 * parcial dejaría celdas en blanco, que es peor que tardar unos milisegundos.
 */
function cachedCells(grid: readonly string[][], entries: CalcCacheEntry[]): Map<string, ComputedCell> | null {
	const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
	const cells = new Map<string, ComputedCell>();
	for (const [r, row] of grid.entries()) {
		for (const [c, raw] of row.entries()) {
			if (!isFormula(raw)) continue;
			const entry = byRef.get(refLabel(r, c));
			if (!entry) return null;
			cells.set(cellKey(r, c), { text: entry.value, kind: "formula", error: false });
		}
	}
	return cells;
}
