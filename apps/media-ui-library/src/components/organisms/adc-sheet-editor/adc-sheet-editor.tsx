import { Component, Event, Host, Listen, Prop, State, Watch, type EventEmitter } from "@stencil/core";
// Solo tipos desde @common (un import de runtime haría que Stencil emita .js junto a la fuente compartida).
import type { AdcSheetEnvelope, SheetCell } from "@common/types/adc-sheet/index.js";
import type { MenuBarItem, MenuBarMenu } from "../../molecules/adc-menu-bar/adc-menu-bar";
import { parseCsv, serializeCsv, type CsvDelimiter } from "../../../../utils/csv.js";
import { cellText, parseAdcSheet, serializeAdcSheet, withCellText } from "../../../../utils/adcsheet.js";
import { SHEET_EXPORT_FORMATS, type SheetExportContext } from "../../../../utils/sheet-formats.js";
import { downloadText, printHtml } from "../../../../utils/document-formats.js";
import { computeSheet, gridHash, isFormula, type CalcCacheEntry, type ComputedCell } from "../../../../utils/sheet-formula/engine.js";
import { FUNCTION_DOMAINS } from "../../../../utils/sheet-formula/functions/index.js";
import { cellKey, columnLetter } from "../../../../utils/sheet-formula/refs.js";

/** Formato del contenido que recibe/emite el editor. */
export type SheetFormat = "csv" | "adcsheet";

/** Menú flotante abierto por click derecho sobre una celda o un rótulo. */
interface OpenMenu {
	items: MenuBarItem[];
	x: number;
	y: number;
}

/** Instantánea del historial: grilla + props de fila + delimitador. */
interface SheetSnapshot {
	rows: SheetCell[][];
	rowMeta: Array<Record<string, unknown> | undefined>;
	delimiter: CsvDelimiter;
}

const DELIMITER_LABELS: Array<{ value: CsvDelimiter; label: string }> = [
	{ value: ",", label: "Coma (,)" },
	{ value: ";", label: "Punto y coma (;)" },
	{ value: "\t", label: "Tabulación" },
];

/** Máximo de estados guardados para deshacer/rehacer. */
const HISTORY_LIMIT = 60;
/** Espera antes de fotografiar la grilla en el historial (agrupa el tecleo). */
const HISTORY_DEBOUNCE_MS = 700;
/** Espera antes de recalcular las fórmulas (para no evaluar la hoja en cada tecla). */
const COMPUTE_DEBOUNCE_MS = 250;

/**
 * Editor de hojas de cálculo con la misma barra que el editor de documentos
 * (`adc-menu-bar`: Archivo / Editar / Insertar / Funciones, fija arriba de
 * todo) y una grilla estilo Excel: columnas de ancho fijo con scroll
 * horizontal, rótulos A/B/C y números de fila pegajosos, barra de fórmulas y
 * deshacer-rehacer.
 *
 * Edita dos formatos: CSV crudo (RFC 4180) y `.adcsheet` (JSON Lines con
 * celdas extensibles por propiedades — color, fórmula — que se conservan al
 * editar). Emite `adcSheetChange` con el contenido serializado en el formato
 * activo; el guardado es responsabilidad del host.
 *
 * **Fórmulas**: una celda que empieza con `=` se calcula en el cliente y se
 * muestra ya resuelta (el texto crudo vuelve mientras se la edita). El archivo
 * guarda **sólo la fórmula**: los valores calculados viven en la caché que el
 * host persiste vía `calcCache`/`adcSheetCalc`, así el archivo no engorda.
 *
 * @example
 * <adc-sheet-editor value={"a,b\n1,2"} format="csv" onadcSheetChange={(e) => save(e.detail.text)} />
 */
@Component({
	tag: "adc-sheet-editor",
	styleUrls: ["../shared-editable-table.css", "adc-sheet-editor.css"],
	shadow: false,
})
export class AdcSheetEditor {
	/** Contenido crudo (CSV o JSON Lines de `.adcsheet` según `format`). */
	@Prop() value: string = "";

	/** Formato del contenido: `csv` (por defecto) o `adcsheet`. */
	@Prop() format: SheetFormat = "csv";

	/** Solo lectura (sin edición ni menús) */
	@Prop() readonly = false;

	/** Delimitador CSV; por defecto se autodetecta ("," / ";" / tab) */
	@Prop() delimiter?: string;

	/**
	 * Ocupa el alto del contenedor: barra fija arriba y grilla con scroll
	 * propio (ambos ejes). Requiere contenedor con altura definida (ej: modal
	 * a pantalla completa). Si es `false`, el editor crece con el contenido.
	 */
	@Prop() fill = false;

	/**
	 * Caché de cálculos que el host trae del servidor, en JSON
	 * (`{docHash, entries}`). Si el hash coincide con el contenido actual, la
	 * hoja se pinta sin evaluar una sola fórmula. Viaja como string y no como
	 * objeto para que un literal nuevo en cada render del host no dispare un
	 * recálculo.
	 */
	@Prop() calcCache?: string;

	@State() rows: SheetCell[][] = [[""]];
	@State() menu: OpenMenu | null = null;
	/** Última celda con foco: ancla de inserciones relativas y de la barra de fórmulas. */
	@State() active: { r: number; c: number } | null = null;
	/** Celda que se está tecleando: muestra la fórmula cruda en vez del resultado. */
	@State() editing: { r: number; c: number } | null = null;
	/** Resultado del último cálculo, por celda (`"fila:columna"`). */
	@State() computed: Map<string, ComputedCell> = new Map();

	/** Props extra por fila (paralelo a `rows`): se conservan, hoy no se editan. */
	private rowMeta: Array<Record<string, unknown> | undefined> = [];
	/** Envelope del `.adcsheet` (título y props futuras); irrelevante en CSV. */
	private envelope: AdcSheetEnvelope = { format: "adc-sheet", version: 1 };
	private activeDelimiter: CsvDelimiter = ",";
	private fileInput?: HTMLInputElement;
	private cellBarInput?: HTMLInputElement;
	/** Historial de deshacer/rehacer (el delimitador también es deshacible). */
	private past: SheetSnapshot[] = [];
	private future: SheetSnapshot[] = [];
	private historyTimer?: ReturnType<typeof setTimeout>;
	private computeTimer?: ReturnType<typeof setTimeout>;
	/** Caché vigente: la del servidor al abrir, la del último cálculo después. */
	private calc: { docHash: string; entries: CalcCacheEntry[] } | null = null;
	/** Última caché emitida: evita avisarle al host de un cambio que no existe. */
	private emittedCalc = "";

	/** Emitido en cada edición con el contenido serializado en el formato activo. */
	@Event() adcSheetChange!: EventEmitter<{ text: string }>;

	/**
	 * Emitido cuando cambian los valores calculados. El host lo persiste (con su
	 * propio debounce) para que la próxima apertura pinte la hoja sin recalcular.
	 */
	@Event() adcSheetCalc!: EventEmitter<{ cache: string }>;

	componentWillLoad(): void {
		this.parseValue();
		this.calc = this.parseCalcCache();
		this.recompute();
	}

	disconnectedCallback(): void {
		if (this.historyTimer) clearTimeout(this.historyTimer);
		if (this.computeTimer) clearTimeout(this.computeTimer);
	}

	@Watch("value")
	@Watch("format")
	handleValueChange(): void {
		this.parseValue();
		this.closeHistoryGroup();
		this.past = [];
		this.future = [];
		this.scheduleCompute(true);
	}

	/**
	 * El host suele traer la caché antes de montar el editor (y entonces ya la usó
	 * `componentWillLoad`). Esto cubre el caso de que llegue después: sólo se
	 * adopta si describe el contenido que hay ahora — una caché de otra versión no
	 * ahorra nada y forzaría un recálculo de más.
	 */
	@Watch("calcCache")
	handleCalcCacheChange(): void {
		const incoming = this.parseCalcCache();
		if (!incoming || incoming.docHash === this.calc?.docHash) return;
		if (incoming.docHash !== gridHash(this.textGrid())) return;
		this.calc = incoming;
		this.scheduleCompute(true);
	}

	private parseCalcCache(): { docHash: string; entries: CalcCacheEntry[] } | null {
		if (!this.calcCache) return null;
		try {
			const parsed = JSON.parse(this.calcCache) as { docHash?: unknown; entries?: unknown };
			if (typeof parsed?.docHash !== "string" || !Array.isArray(parsed.entries)) return null;
			return { docHash: parsed.docHash, entries: parsed.entries as CalcCacheEntry[] };
		} catch {
			return null;
		}
	}

	private parseValue(): void {
		if (this.format === "adcsheet") {
			const sheet = parseAdcSheet(this.value ?? "");
			if (sheet) {
				this.envelope = sheet.envelope;
				this.rowMeta = [...sheet.rowProps];
				this.rows = AdcSheetEditor.normalize(sheet.rows);
				return;
			}
			// Envelope roto: se muestra el texto como grilla (mejor que perderlo).
		}
		const parsed = parseCsv(this.value ?? "", this.delimiter as CsvDelimiter | undefined);
		this.activeDelimiter = parsed.delimiter;
		this.rowMeta = [];
		this.rows = AdcSheetEditor.normalize(parsed.rows);
	}

	/** Grilla rectangular: rellena con celdas vacías las filas más cortas. */
	private static normalize(rows: SheetCell[][]): SheetCell[][] {
		if (rows.length === 0) return [[""]];
		// Sin spread en Math.max: con cientos de miles de filas revienta la pila.
		let cols = 1;
		for (const row of rows) cols = Math.max(cols, row.length);
		return rows.map((row) => (row.length === cols ? row : [...row, ...Array.from({ length: cols - row.length }, () => "")]));
	}

	/** Grilla de solo texto: lo que el usuario escribió, fórmulas incluidas. */
	private textGrid(): string[][] {
		return this.rows.map((row) => row.map(cellText));
	}

	/**
	 * Grilla como se ve: los valores calculados en lugar de las fórmulas. Es la
	 * que se exporta e imprime — un `.csv` que sale con `=SUM(...)` adentro no le
	 * sirve a nadie.
	 */
	private displayGrid(): string[][] {
		if (this.computed.size === 0) return this.textGrid();
		return this.rows.map((row, r) => row.map((cell, c) => this.computed.get(cellKey(r, c))?.text ?? cellText(cell)));
	}

	private serialize(): string {
		if (this.format === "adcsheet") {
			return serializeAdcSheet({ envelope: this.envelope, rows: this.rows, rowProps: this.rowMeta });
		}
		return serializeCsv(this.textGrid(), this.activeDelimiter);
	}

	private emitChange(): void {
		this.adcSheetChange.emit({ text: this.serialize() });
		this.scheduleCompute();
	}

	// ── Cálculo de fórmulas ─────────────────────────────────────────────────

	/**
	 * Recalcula con debounce: escribir en una celda no puede disparar una
	 * evaluación de la hoja entera por cada tecla.
	 */
	private scheduleCompute(immediate = false): void {
		if (this.computeTimer) clearTimeout(this.computeTimer);
		if (immediate) {
			this.computeTimer = undefined;
			this.recompute();
			return;
		}
		this.computeTimer = setTimeout(() => {
			this.computeTimer = undefined;
			this.recompute();
		}, COMPUTE_DEBOUNCE_MS);
	}

	private recompute(): void {
		const result = computeSheet(this.textGrid(), { cache: this.calc ?? undefined });
		this.computed = result.cells;
		this.calc = { docHash: result.docHash, entries: result.entries };
		// Sin fórmulas no hay nada que cachear: no se le manda una caché vacía al servidor.
		const payload = result.entries.length > 0 ? JSON.stringify(this.calc) : "";
		if (payload === this.emittedCalc) return;
		this.emittedCalc = payload;
		this.adcSheetCalc.emit({ cache: payload });
	}

	private snapshot(): SheetSnapshot {
		return { rows: this.rows, rowMeta: this.rowMeta, delimiter: this.activeDelimiter };
	}

	/**
	 * Aplica una edición: historial + evento. El debounce solo agrupa la toma
	 * de instantáneas durante una ráfaga de tecleo; una edición real SIEMPRE
	 * invalida el redo.
	 */
	private apply(rows: SheetCell[][], rowMeta = this.rowMeta, delimiter = this.activeDelimiter): void {
		if (this.historyTimer) clearTimeout(this.historyTimer);
		else this.past = [...this.past.slice(-(HISTORY_LIMIT - 1)), this.snapshot()];
		this.future = [];
		this.historyTimer = setTimeout(() => (this.historyTimer = undefined), HISTORY_DEBOUNCE_MS);
		this.rows = rows;
		this.rowMeta = rowMeta;
		this.activeDelimiter = delimiter;
		this.emitChange();
	}

	/** Cierra el grupo de tecleo en curso: el próximo apply() vuelve a snapshotear. */
	private closeHistoryGroup(): void {
		if (!this.historyTimer) return;
		clearTimeout(this.historyTimer);
		this.historyTimer = undefined;
	}

	private restore(from: SheetSnapshot[], into: SheetSnapshot[]): void {
		const state = from.pop();
		if (!state) return;
		this.closeHistoryGroup();
		into.push(this.snapshot());
		this.rows = state.rows;
		this.rowMeta = state.rowMeta;
		this.activeDelimiter = state.delimiter;
		this.emitChange();
	}

	private undo(): void {
		this.restore(this.past, this.future);
	}

	private redo(): void {
		this.restore(this.future, this.past);
	}

	// ── Mutaciones de la grilla ─────────────────────────────────────────────

	/** Reemplaza el texto de una celda conservando sus propiedades (color, fórmula). */
	private setCell(r: number, c: number, text: string): void {
		const rows = this.rows.map((row) => [...row]);
		rows[r][c] = withCellText(rows[r][c] ?? "", text);
		this.apply(rows);
	}

	/** Inserta una fila vacía en la posición `at` (clampeada al rango válido). */
	private insertRow(at: number): void {
		const cols = this.rows[0]?.length ?? 1;
		const index = Math.min(Math.max(0, at), this.rows.length);
		const rows = [...this.rows];
		rows.splice(index, 0, Array.from({ length: cols }, () => ""));
		const meta = [...this.rowMeta];
		meta.splice(index, 0, undefined);
		this.apply(rows, meta);
	}

	/** Inserta una columna vacía en la posición `at` de todas las filas. */
	private insertColumn(at: number): void {
		const cols = this.rows[0]?.length ?? 1;
		const index = Math.min(Math.max(0, at), cols);
		this.apply(
			this.rows.map((row) => {
				const next = [...row];
				next.splice(index, 0, "");
				return next;
			})
		);
	}

	private removeRow(r: number): void {
		if (this.rows.length <= 1 || r < 0 || r >= this.rows.length) return;
		this.apply(
			this.rows.filter((_, i) => i !== r),
			this.rowMeta.filter((_, i) => i !== r)
		);
		this.active = null;
	}

	private removeColumn(c: number): void {
		if ((this.rows[0]?.length ?? 0) <= 1 || c < 0) return;
		this.apply(this.rows.map((row) => row.filter((_, i) => i !== c)));
		this.active = null;
	}

	// ── Import / export ─────────────────────────────────────────────────────

	private importFile(file: File): void {
		void file.text().then((text) => {
			// apply() snapshotea el estado previo (delimitador incluido) antes de pisar.
			this.closeHistoryGroup();
			const sheet = /\.adcsheet$/i.test(file.name) ? parseAdcSheet(text) : null;
			if (sheet) {
				this.apply(AdcSheetEditor.normalize(sheet.rows), [...sheet.rowProps]);
				return;
			}
			const parsed = parseCsv(text);
			this.apply(AdcSheetEditor.normalize(parsed.rows), [], parsed.delimiter);
		});
	}

	/** Nombre base de las descargas: el título de la hoja o "tabla". */
	private baseName(): string {
		return (typeof this.envelope.title === "string" && this.envelope.title.trim()) || "tabla";
	}

	private exportContext(): SheetExportContext {
		return {
			display: this.displayGrid(),
			rows: this.rows,
			rowProps: this.rowMeta,
			envelope: this.envelope,
			delimiter: this.activeDelimiter,
			title: this.baseName(),
		};
	}

	/**
	 * Formatos del submenú "Exportar". Imprimir queda afuera (tiene su propio item
	 * arriba) y el `.adcsheet` sólo aparece desde un CSV, como puente al formato
	 * nativo — ofrecerlo mientras se edita un `.adcsheet` sería bajar el archivo
	 * que ya se está editando.
	 */
	private availableExports() {
		return SHEET_EXPORT_FORMATS.filter((format) => !format.print && (format.id !== "adcsheet" || this.format === "csv"));
	}

	private exportAs(id: string): void {
		const format = SHEET_EXPORT_FORMATS.find((candidate) => candidate.id === id);
		if (!format) return;
		const content = format.serialize(this.exportContext());
		if (format.print) printHtml(content);
		else downloadText(content, `${this.baseName()}.${format.ext}`, format.mime);
	}

	private setDelimiter(delimiter: CsvDelimiter): void {
		if (delimiter === this.activeDelimiter) return;
		// Un cambio de delimitador reescribe el archivo: también es deshacible.
		this.closeHistoryGroup();
		this.apply(this.rows, this.rowMeta, delimiter);
	}

	// ── Menús ───────────────────────────────────────────────────────────────

	private fileMenuItems(): MenuBarItem[] {
		return [
			{ label: "Importar archivo…", action: "file:import" },
			{ label: "Imprimir… (Ctrl+P)", action: "export:print" },
			{ label: "Exportar…", children: this.availableExports().map((f) => ({ label: f.label, action: `export:${f.id}` })) },
			...(this.format === "csv"
				? [
						{
							label: "Delimitador",
							children: DELIMITER_LABELS.map((d) => ({
								label: d.value === this.activeDelimiter ? `✓ ${d.label}` : d.label,
								action: `delim:${d.value === "\t" ? "tab" : d.value}`,
							})),
						},
					]
				: []),
		];
	}

	private editMenuItems(): MenuBarItem[] {
		return [
			{ label: this.past.length ? "Deshacer (Ctrl+Z)" : "Deshacer", action: "edit:undo" },
			{ label: this.future.length ? "Rehacer (Ctrl+Y)" : "Rehacer", action: "edit:redo" },
			{ label: "Eliminar fila actual", action: "edit:del-row", danger: true },
			{ label: "Eliminar columna actual", action: "edit:del-col", danger: true },
		];
	}

	private insertMenuItems(): MenuBarItem[] {
		return [
			{
				label: "Fila",
				children: [
					{ label: "Arriba de la actual", action: "insert:row-above" },
					{ label: "Debajo de la actual", action: "insert:row-below" },
					{ label: "Al final", action: "insert:row-end" },
				],
			},
			{
				label: "Columna",
				children: [
					{ label: "A la izquierda de la actual", action: "insert:col-left" },
					{ label: "A la derecha de la actual", action: "insert:col-right" },
					{ label: "Al final", action: "insert:col-end" },
				],
			},
		];
	}

	/** Catálogo de funciones agrupado por dominio; cada item la escribe en la celda. */
	private functionMenuItems(): MenuBarItem[] {
		return FUNCTION_DOMAINS.map((domain) => ({
			label: domain.label,
			children: domain.functions.map((fn) => ({ label: fn.help, action: `fn:${fn.name}` })),
		}));
	}

	private barMenus(): MenuBarMenu[] {
		return [
			{ label: "Archivo", items: () => this.fileMenuItems() },
			{ label: "Editar", items: () => this.editMenuItems() },
			{ label: "Insertar", items: () => this.insertMenuItems() },
			{ label: "Funciones", items: () => this.functionMenuItems() },
		];
	}

	/**
	 * Menú contextual según dónde se hizo click derecho: una celda ofrece ambos
	 * ejes; un rótulo de fila/columna solo las acciones de su eje (no se inventa
	 * la otra coordenada).
	 */
	private cellMenuItems(axis: "cell" | "row" | "col"): MenuBarItem[] {
		const rowItems: MenuBarItem[] = [
			{ label: "Insertar fila arriba", action: "insert:row-above" },
			{ label: "Insertar fila debajo", action: "insert:row-below" },
			{ label: "Eliminar fila", action: "edit:del-row", danger: true },
		];
		const colItems: MenuBarItem[] = [
			{ label: "Insertar columna a la izquierda", action: "insert:col-left" },
			{ label: "Insertar columna a la derecha", action: "insert:col-right" },
			{ label: "Eliminar columna", action: "edit:del-col", danger: true },
		];
		if (axis === "row") return rowItems;
		if (axis === "col") return colItems;
		return [...rowItems.slice(0, 2), ...colItems.slice(0, 2), rowItems[2], colItems[2]];
	}

	private handleMenuSelect(action: string): void {
		this.menu = null;
		const [group, value] = action.split(":");
		switch (group) {
			case "insert":
				this.runInsertAction(value);
				break;
			case "edit":
				this.runEditAction(value);
				break;
			case "export":
				this.exportAs(value);
				break;
			case "fn":
				this.insertFunction(value);
				break;
			case "file":
				if (value === "import") this.fileInput?.click();
				break;
			case "delim":
				this.setDelimiter(value === "tab" ? "\t" : (value as CsvDelimiter));
				break;
		}
	}

	/**
	 * Escribe `=NOMBRE(` en la celda activa y deja el cursor en la barra de
	 * fórmulas para completar los argumentos.
	 */
	private insertFunction(name: string): void {
		const cell = this.active;
		if (!cell || this.readonly) return;
		const current = cellText(this.rows[cell.r]?.[cell.c] ?? "");
		this.setCell(cell.r, cell.c, current.startsWith("=") ? `${current}${name}(` : `=${name}(`);
		this.editing = { ...cell };
		requestAnimationFrame(() => {
			this.cellBarInput?.focus();
			const end = this.cellBarInput?.value.length ?? 0;
			this.cellBarInput?.setSelectionRange(end, end);
		});
	}

	private runInsertAction(value: string): void {
		const cell = this.active;
		const endRow = this.rows.length;
		const endCol = this.rows[0]?.length ?? 1;
		switch (value) {
			case "row-above":
				this.insertRow(cell?.r ?? endRow);
				break;
			case "row-below":
				this.insertRow(cell ? cell.r + 1 : endRow);
				break;
			case "row-end":
				this.insertRow(endRow);
				break;
			case "col-left":
				this.insertColumn(cell?.c ?? endCol);
				break;
			case "col-right":
				this.insertColumn(cell ? cell.c + 1 : endCol);
				break;
			case "col-end":
				this.insertColumn(endCol);
				break;
		}
	}

	private runEditAction(value: string): void {
		const cell = this.active;
		if (value === "undo") this.undo();
		else if (value === "redo") this.redo();
		else if (value === "del-row" && cell) this.removeRow(cell.r);
		else if (value === "del-col" && cell) this.removeColumn(cell.c);
	}

	/**
	 * Ctrl/Cmd+Z / Ctrl/Cmd+Y (o Shift+Z) para deshacer/rehacer y Ctrl/Cmd+P
	 * para imprimir. El de imprimir escucha en el documento y no en el host:
	 * si no, el navegador imprimiría la aplicación entera cada vez que el foco
	 * está fuera de la grilla (por ejemplo en el botón de guardar del host).
	 */
	@Listen("keydown", { target: "document" })
	handleKeyDown(ev: KeyboardEvent) {
		if (!(ev.ctrlKey || ev.metaKey)) return;
		const key = ev.key.toLowerCase();
		if (key === "p") {
			ev.preventDefault();
			this.exportAs("print");
			return;
		}
		if (this.readonly) return;
		const redo = key === "y" || (key === "z" && ev.shiftKey);
		if (redo) {
			ev.preventDefault();
			this.redo();
		} else if (key === "z") {
			ev.preventDefault();
			this.undo();
		}
	}

	private cellContextMenu(r: number, c: number, axis: "cell" | "row" | "col" = "cell") {
		if (this.readonly) return {};
		return {
			onContextMenu: (ev: MouseEvent) => {
				ev.preventDefault();
				// El host (ej: Drive) también escucha contextmenu: solo debe abrirse este menú.
				ev.stopPropagation();
				this.active = { r, c };
				this.menu = { items: this.cellMenuItems(axis), x: ev.clientX, y: ev.clientY };
			},
		};
	}

	// ── Render ──────────────────────────────────────────────────────────────

	private renderToolbar() {
		const dims = `${this.rows.length} fila${this.rows.length === 1 ? "" : "s"} × ${this.rows[0]?.length ?? 0} col.`;
		return (
			<div class="adc-editor-toolbar">
				<adc-menu-bar
					menus={this.barMenus()}
					onAdcMenuBarSelect={(ev: CustomEvent<{ action: string }>) => this.handleMenuSelect(ev.detail.action)}
				></adc-menu-bar>
				<input
					type="file"
					accept=".csv,.tsv,.txt,.adcsheet"
					class="hidden"
					ref={(el) => (this.fileInput = el)}
					onChange={(ev: globalThis.Event) => {
						const input = ev.target as HTMLInputElement;
						const file = input.files?.[0];
						if (file) this.importFile(file);
						input.value = "";
					}}
				/>
				<span class="flex-1"></span>
				<span class="text-xs text-muted whitespace-nowrap pr-1">{dims}</span>
			</div>
		);
	}

	/** Barra de fórmulas: referencia, contenido crudo y resultado de la celda activa. */
	private renderCellBar() {
		const active = this.active;
		const text = active ? cellText(this.rows[active.r]?.[active.c] ?? "") : "";
		const result = active && isFormula(text) ? this.computed.get(cellKey(active.r, active.c)) : undefined;
		return (
			<div class="adc-sheet-editor__cellbar">
				<span class="adc-sheet-editor__cellref">{active ? `${columnLetter(active.c)}${active.r + 1}` : "—"}</span>
				<input
					class="adc-sheet-editor__cellinput"
					value={text}
					disabled={!active}
					placeholder={active ? "Escribí un valor, o = para una fórmula" : "Seleccioná una celda"}
					aria-label="Contenido de la celda activa"
					ref={(el) => (this.cellBarInput = el)}
					onFocus={() => (this.editing = active ? { ...active } : null)}
					onBlur={() => (this.editing = null)}
					onInput={(ev: InputEvent) => {
						if (active) this.setCell(active.r, active.c, (ev.target as HTMLInputElement).value);
					}}
				/>
				{result && (
					<span class={`adc-sheet-editor__result ${result.error ? "adc-sheet-editor__result--error" : ""}`} title="Resultado">
						= {result.text}
					</span>
				)}
			</div>
		);
	}

	private renderCell(r: number, c: number, cell: SheetCell) {
		const raw = cellText(cell);
		const computed = this.computed.get(cellKey(r, c));
		const errorClass = computed?.error ? " adc-sheet-editor__cell--error" : "";

		// Celda ocupada por el derrame de otra fórmula: se muestra, no se edita
		// (para recuperarla alcanza con borrar la fórmula que la llena).
		if (computed?.kind === "spill") {
			return (
				<span class="adc-sheet-editor__spill" title="Resultado derramado por una fórmula de arriba">
					{computed.text}
				</span>
			);
		}
		if (this.readonly) {
			return <span class={`block text-sm text-text whitespace-pre-wrap${errorClass}`}>{computed?.text ?? raw}</span>;
		}
		// Mientras se teclea se ve la fórmula; con el foco afuera, su resultado.
		const editing = this.editing?.r === r && this.editing?.c === c;
		return (
			<input
				class={`w-full bg-transparent text-inherit font-inherit outline-none${errorClass}`}
				value={editing || !computed ? raw : computed.text}
				title={computed ? raw : undefined}
				onFocus={() => {
					this.active = { r, c };
					this.editing = { r, c };
				}}
				onBlur={() => (this.editing = null)}
				onInput={(ev: InputEvent) => this.setCell(r, c, (ev.target as HTMLInputElement).value)}
				aria-label={`${columnLetter(c)}${r + 1}`}
			/>
		);
	}

	/**
	 * Pin `+` sobre el borde de un rótulo: inserta una fila/columna justo en ese
	 * límite. Aparece al pasar el mouse por el rótulo, como en cualquier planilla.
	 */
	private renderAddPin(axis: "row" | "col", at: number, side: "start" | "end") {
		const label = axis === "row" ? `Insertar fila ${at + 1}` : `Insertar columna ${columnLetter(at)}`;
		return (
			<button
				key={`add-${side}`}
				type="button"
				class={`adc-sheet-editor__add adc-sheet-editor__add--${axis} adc-sheet-editor__add--${side}`}
				title={label}
				aria-label={label}
				onClick={(ev: MouseEvent) => {
					ev.stopPropagation();
					if (axis === "row") this.insertRow(at);
					else this.insertColumn(at);
				}}
			>
				+
			</button>
		);
	}

	private renderColumnHead(c: number) {
		return (
			<th key={`col-${c}`} class="adc-sheet-editor__head" {...this.cellContextMenu(0, c, "col")}>
				{columnLetter(c)}
				{!this.readonly && [
					<button
						key="kill"
						type="button"
						class="adc-sheet-editor__kill"
						title={`Eliminar columna ${columnLetter(c)}`}
						onClick={() => this.removeColumn(c)}
					>
						×
					</button>,
					this.renderAddPin("col", c, "start"),
					this.renderAddPin("col", c + 1, "end"),
				]}
			</th>
		);
	}

	private renderRowHead(r: number) {
		return (
			<th class="adc-sheet-editor__head adc-sheet-editor__rowhead" {...this.cellContextMenu(r, 0, "row")}>
				{r + 1}
				{!this.readonly && [
					<button key="kill" type="button" class="adc-sheet-editor__kill" title={`Eliminar fila ${r + 1}`} onClick={() => this.removeRow(r)}>
						×
					</button>,
					this.renderAddPin("row", r, "start"),
					this.renderAddPin("row", r + 1, "end"),
				]}
			</th>
		);
	}

	private renderGrid() {
		const colCount = this.rows[0]?.length ?? 1;
		return (
			<table class="adc-blocks-editor__table adc-sheet-editor__table">
				{/* Rótulos de hoja de cálculo: letras de columna y números de fila pegajosos. */}
				<thead>
					<tr>
						<th class="adc-sheet-editor__head adc-sheet-editor__rowhead">
							<span class="sr-only">Número de fila</span>
						</th>
						{Array.from({ length: colCount }, (_, c) => this.renderColumnHead(c))}
					</tr>
				</thead>
				<tbody>
					{this.rows.map((row, r) => (
						<tr key={`row-${r}`} class={r === 0 ? "adc-sheet-editor__headrow" : ""}>
							{this.renderRowHead(r)}
							{row.map((cell, c) => (
								<td key={`cell-${r}-${c}`} class="adc-blocks-editor__table-cell" {...this.cellContextMenu(r, c)}>
									{this.renderCell(r, c, cell)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		);
	}

	render() {
		return (
			<Host class={this.fill ? "block h-full min-h-0" : ""}>
				<div class={`flex flex-col ${this.fill ? "h-full min-h-0" : ""}`}>
					{!this.readonly && this.renderToolbar()}
					{!this.readonly && this.renderCellBar()}
					<div class={`adc-sheet-editor__viewport ${this.fill ? "flex-1 min-h-0" : ""}`}>{this.renderGrid()}</div>
					<adc-context-menu
						open={this.menu !== null}
						x={this.menu?.x ?? 0}
						y={this.menu?.y ?? 0}
						items={this.menu?.items ?? []}
						onAdcContextMenuClose={() => (this.menu = null)}
						onAdcContextMenuSelect={(ev: CustomEvent<{ action: string }>) => this.handleMenuSelect(ev.detail.action)}
					></adc-context-menu>
				</div>
			</Host>
		);
	}
}
