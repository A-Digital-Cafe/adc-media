import { Component, Event, Host, Listen, Prop, State, Watch, type EventEmitter } from "@stencil/core";
// Solo tipos desde @common (un import de runtime haría que Stencil emita .js junto a la fuente compartida).
import type { AdcDocument } from "@common/types/adc-document/index.js";
import type { AdcSheetEnvelope, SheetCell } from "@common/types/adc-sheet/index.js";
import type { MenuBarItem, MenuBarMenu } from "../../molecules/adc-menu-bar/adc-menu-bar";
import { parseCsv, serializeCsv, type CsvDelimiter } from "../../../../utils/csv.js";
import { cellText, parseAdcSheet, serializeAdcSheet, sheetToFods, withCellText } from "../../../../utils/adcsheet.js";
import { docToHtml, docToMarkdown } from "../../../../utils/doc-export.js";
import { downloadText } from "../../../../utils/document-formats.js";

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

/** Espejo del mime de @common/types/adc-sheet (acá solo se importan tipos). */
const SHEET_FILE_MIME = "application/x-adc-sheet";

/** Máximo de estados guardados para deshacer/rehacer. */
const HISTORY_LIMIT = 60;
/** Espera antes de fotografiar la grilla en el historial (agrupa el tecleo). */
const HISTORY_DEBOUNCE_MS = 700;

/** Rótulo de columna estilo hoja de cálculo (A, B, …, Z, AA, AB, …). */
function columnLetter(index: number): string {
	let label = "";
	let i = index + 1;
	while (i > 0) {
		i -= 1;
		label = String.fromCodePoint(65 + (i % 26)) + label;
		i = Math.floor(i / 26);
	}
	return label;
}

/**
 * Editor de hojas de cálculo con la misma barra que el editor de documentos
 * (`adc-menu-bar`: Archivo / Editar / Insertar, fija arriba de todo) y una
 * grilla estilo Excel: columnas de ancho fijo con scroll horizontal, rótulos
 * A/B/C y números de fila pegajosos, barra de celda (futura barra de fórmulas)
 * y deshacer-rehacer.
 *
 * Edita dos formatos: CSV crudo (RFC 4180) y `.adcsheet` (JSON Lines con
 * celdas extensibles por propiedades — color, fórmula — que se conservan al
 * editar). Emite `adcSheetChange` con el contenido serializado en el formato
 * activo; el guardado es responsabilidad del host.
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

	@State() rows: SheetCell[][] = [[""]];
	@State() menu: OpenMenu | null = null;
	/** Última celda con foco: ancla de inserciones relativas y de la barra de celda. */
	@State() active: { r: number; c: number } | null = null;

	/** Props extra por fila (paralelo a `rows`): se conservan, hoy no se editan. */
	private rowMeta: Array<Record<string, unknown> | undefined> = [];
	/** Envelope del `.adcsheet` (título y props futuras); irrelevante en CSV. */
	private envelope: AdcSheetEnvelope = { format: "adc-sheet", version: 1 };
	private activeDelimiter: CsvDelimiter = ",";
	private fileInput?: HTMLInputElement;
	/** Historial de deshacer/rehacer (el delimitador también es deshacible). */
	private past: SheetSnapshot[] = [];
	private future: SheetSnapshot[] = [];
	private historyTimer?: ReturnType<typeof setTimeout>;

	/** Emitido en cada edición con el contenido serializado en el formato activo. */
	@Event() adcSheetChange!: EventEmitter<{ text: string }>;

	componentWillLoad(): void {
		this.parseValue();
	}

	disconnectedCallback(): void {
		if (this.historyTimer) clearTimeout(this.historyTimer);
	}

	@Watch("value")
	@Watch("format")
	handleValueChange(): void {
		this.parseValue();
		this.closeHistoryGroup();
		this.past = [];
		this.future = [];
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

	/** Grilla de solo texto (para CSV y exportaciones sin propiedades). */
	private textGrid(): string[][] {
		return this.rows.map((row) => row.map(cellText));
	}

	private serialize(): string {
		if (this.format === "adcsheet") {
			return serializeAdcSheet({ envelope: this.envelope, rows: this.rows, rowProps: this.rowMeta });
		}
		return serializeCsv(this.textGrid(), this.activeDelimiter);
	}

	private emitChange(): void {
		this.adcSheetChange.emit({ text: this.serialize() });
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

	/** Documento ADC con la tabla actual (sin re-parsear el CSV: no hay redetección). */
	private tableDoc(): AdcDocument {
		const [header = [], ...body] = this.textGrid();
		return { format: "adc-document", version: 1, blocks: [{ type: "table-x", header, rows: body }] };
	}

	/** Nombre base de las descargas: el título de la hoja o "tabla". */
	private baseName(): string {
		return (typeof this.envelope.title === "string" && this.envelope.title.trim()) || "tabla";
	}

	private exportAs(format: string): void {
		const base = this.baseName();
		switch (format) {
			case "csv":
				downloadText(serializeCsv(this.textGrid(), this.activeDelimiter), `${base}.csv`, "text/csv");
				break;
			case "fods":
				downloadText(sheetToFods(this.rows, base), `${base}.fods`, "application/vnd.oasis.opendocument.spreadsheet");
				break;
			case "adcsheet":
				downloadText(serializeAdcSheet({ envelope: this.envelope, rows: this.rows, rowProps: this.rowMeta }), `${base}.adcsheet`, SHEET_FILE_MIME);
				break;
			case "md":
				downloadText(docToMarkdown(this.tableDoc()), `${base}.md`, "text/markdown");
				break;
			case "html":
				downloadText(docToHtml(this.tableDoc()), `${base}.html`, "text/html");
				break;
		}
	}

	private setDelimiter(delimiter: CsvDelimiter): void {
		if (delimiter === this.activeDelimiter) return;
		// Un cambio de delimitador reescribe el archivo: también es deshacible.
		this.closeHistoryGroup();
		this.apply(this.rows, this.rowMeta, delimiter);
	}

	// ── Menús ───────────────────────────────────────────────────────────────

	private fileMenuItems(): MenuBarItem[] {
		const exportChildren: MenuBarItem[] = [
			{ label: "CSV (.csv)", action: "export:csv" },
			{ label: "Planilla OpenDocument (.fods)", action: "export:fods" },
			// Puente entre formatos: desde CSV se puede bajar la versión `.adcsheet`.
			...(this.format === "csv" ? [{ label: "Hoja de cálculo ADC (.adcsheet)", action: "export:adcsheet" }] : []),
			{ label: "Tabla Markdown (.md)", action: "export:md" },
			{ label: "Página web (.html)", action: "export:html" },
		];
		return [
			{ label: "Importar archivo…", action: "file:import" },
			{ label: "Exportar…", children: exportChildren },
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

	private barMenus(): MenuBarMenu[] {
		return [
			{ label: "Archivo", items: () => this.fileMenuItems() },
			{ label: "Editar", items: () => this.editMenuItems() },
			{ label: "Insertar", items: () => this.insertMenuItems() },
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
			case "file":
				if (value === "import") this.fileInput?.click();
				break;
			case "delim":
				this.setDelimiter(value === "tab" ? "\t" : (value as CsvDelimiter));
				break;
		}
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

	/** Ctrl/Cmd+Z / Ctrl/Cmd+Y (o Shift+Z): deshacer/rehacer desde cualquier celda. */
	@Listen("keydown")
	handleKeyDown(ev: KeyboardEvent) {
		if (this.readonly || !(ev.ctrlKey || ev.metaKey)) return;
		const key = ev.key.toLowerCase();
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

	/** Barra de celda (referencia + valor): el lugar de las futuras fórmulas. */
	private renderCellBar() {
		const active = this.active;
		const text = active ? cellText(this.rows[active.r]?.[active.c] ?? "") : "";
		return (
			<div class="adc-sheet-editor__cellbar">
				<span class="adc-sheet-editor__cellref">{active ? `${columnLetter(active.c)}${active.r + 1}` : "—"}</span>
				<input
					class="adc-sheet-editor__cellinput"
					value={text}
					disabled={!active}
					placeholder={active ? "" : "Seleccioná una celda"}
					aria-label="Valor de la celda activa"
					onInput={(ev: InputEvent) => {
						if (active) this.setCell(active.r, active.c, (ev.target as HTMLInputElement).value);
					}}
				/>
			</div>
		);
	}

	private renderCell(r: number, c: number, cell: SheetCell) {
		const text = cellText(cell);
		if (this.readonly) {
			return <span class="block text-sm text-text whitespace-pre-wrap">{text}</span>;
		}
		return (
			<input
				class="w-full bg-transparent text-inherit font-inherit outline-none"
				value={text}
				onFocus={() => (this.active = { r, c })}
				onInput={(ev: InputEvent) => this.setCell(r, c, (ev.target as HTMLInputElement).value)}
				aria-label={`${columnLetter(c)}${r + 1}`}
			/>
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
						{Array.from({ length: colCount }, (_, c) => (
							<th key={`col-${c}`} class="adc-sheet-editor__head" {...this.cellContextMenu(0, c, "col")}>
								{columnLetter(c)}
								{!this.readonly && (
									<button
										type="button"
										class="adc-sheet-editor__kill"
										title={`Eliminar columna ${columnLetter(c)}`}
										onClick={() => this.removeColumn(c)}
									>
										×
									</button>
								)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{this.rows.map((row, r) => (
						<tr key={`row-${r}`} class={r === 0 ? "adc-sheet-editor__headrow" : ""}>
							<th class="adc-sheet-editor__head adc-sheet-editor__rowhead" {...this.cellContextMenu(r, 0, "row")}>
								{r + 1}
								{!this.readonly && (
									<button type="button" class="adc-sheet-editor__kill" title={`Eliminar fila ${r + 1}`} onClick={() => this.removeRow(r)}>
										×
									</button>
								)}
							</th>
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
