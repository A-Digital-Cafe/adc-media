/**
 * Utilidades comunes a las strategies de función: aplanado de argumentos,
 * criterios estilo `">100"` y resolución de columnas dentro de un rango.
 */

import { fail, isError, type Arg, type FormulaError, type RangeArg, type Scalar } from "../types.js";
import { columnIndex } from "../refs.js";
import { compareValues, looseEquals, toNumber, toText } from "../values.js";

/** Matriz de un argumento: el rango tal cual, el escalar como matriz 1×1. */
export function matrixOf(arg: Arg | undefined): Scalar[][] {
	if (!arg) return [[null]];
	return arg.kind === "range" ? arg.values : [[arg.value]];
}

/** Primer valor de un argumento (el escalar, o la esquina del rango). */
export function scalarOf(arg: Arg | undefined): Scalar {
	if (!arg) return null;
	return arg.kind === "range" ? (arg.values[0]?.[0] ?? null) : arg.value;
}

/** Todos los valores de todos los argumentos, en orden de lectura. */
export function flatten(args: Arg[]): Scalar[] {
	const out: Scalar[] = [];
	for (const arg of args) {
		if (arg.kind === "scalar") out.push(arg.value);
		else for (const row of arg.values) out.push(...row);
	}
	return out;
}

/**
 * Números de los argumentos con el criterio de toda hoja de cálculo: dentro de
 * un rango, el texto y los vacíos **se ignoran** (una columna con encabezado
 * suma igual); un escalar que no es número sí es `#VALUE!` (lo escribió el
 * usuario a mano y quiso decir otra cosa).
 */
export function collectNumbers(args: Arg[]): number[] | FormulaError {
	const out: number[] = [];
	for (const arg of args) {
		if (arg.kind === "scalar") {
			if (arg.value === null) continue;
			const n = toNumber(arg.value);
			if (isError(n)) return n;
			out.push(n);
			continue;
		}
		for (const row of arg.values) {
			for (const value of row) {
				if (isError(value)) return value;
				if (typeof value === "number") out.push(value);
				else if (typeof value === "boolean") out.push(value ? 1 : 0);
			}
		}
	}
	return out;
}

/** Número de un argumento escalar (estricto: el texto no numérico es `#VALUE!`). */
export function numberArg(arg: Arg | undefined): number | FormulaError {
	return toNumber(scalarOf(arg));
}

/** Entero de un argumento, con piso opcional. */
export function intArg(arg: Arg | undefined, min = Number.NEGATIVE_INFINITY): number | FormulaError {
	const n = numberArg(arg);
	if (isError(n)) return n;
	const value = Math.trunc(n);
	return value < min ? fail("#NUM!") : value;
}

const CRITERION_RE = /^\s*(<>|>=|<=|=|>|<)?\s*(.*)$/s;

/**
 * Criterio estilo hoja de cálculo (`">100"`, `"<>0"`, `"Juan"`, `"a*"`). Sin
 * operador equivale a igualdad; `*` y `?` son comodines en el texto.
 */
export function matchesCriterion(value: Scalar, criterion: Scalar): boolean {
	if (typeof criterion !== "string") return looseEquals(value, criterion);
	const [, op = "=", rawOperand] = CRITERION_RE.exec(criterion)!;
	const operand: Scalar = rawOperand === "" ? null : (toNumberOrText(rawOperand) as Scalar);

	if (op === "=" || op === "<>") {
		const equal = typeof operand === "string" && /[*?]/.test(operand) ? wildcardMatch(toText(value), operand) : looseEquals(value, operand);
		return op === "=" ? equal : !equal;
	}
	// Comparaciones de orden: un vacío nunca entra (como en SQL con NULL).
	if (value === null) return false;
	const cmp = compareValues(value, operand);
	if (op === ">") return cmp > 0;
	if (op === ">=") return cmp >= 0;
	if (op === "<") return cmp < 0;
	return cmp <= 0;
}

function toNumberOrText(text: string): number | string | boolean {
	const trimmed = text.trim();
	const upper = trimmed.toUpperCase();
	if (upper === "TRUE") return true;
	if (upper === "FALSE") return false;
	if (/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) return Number(trimmed);
	return trimmed;
}

function wildcardMatch(text: string, pattern: string): boolean {
	const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
	const regex = new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu");
	return regex.test(text);
}

/**
 * Columna de un rango indicada por: posición 1-based dentro del rango, letra de
 * columna de la hoja (`"C"`, sólo si cae dentro) o texto del encabezado (la
 * primera fila del rango). Devuelve el índice 0-based dentro del rango o `-1`.
 */
export function resolveColumn(range: RangeArg, selector: Scalar): number {
	const width = range.values[0]?.length ?? 0;
	if (typeof selector === "number") {
		const index = Math.trunc(selector) - 1;
		return index >= 0 && index < width ? index : -1;
	}
	const text = toText(selector).trim();
	if (text === "") return -1;
	if (/^\d+$/.test(text)) {
		const index = Number(text) - 1;
		return index >= 0 && index < width ? index : -1;
	}
	if (/^[A-Za-z]{1,3}$/.test(text)) {
		const sheetColumn = columnIndex(text);
		const index = sheetColumn - range.left;
		if (index >= 0 && index < width) return index;
	}
	const header = range.values[0] ?? [];
	return header.findIndex((cell) => toText(cell).trim().toLowerCase() === text.toLowerCase());
}
