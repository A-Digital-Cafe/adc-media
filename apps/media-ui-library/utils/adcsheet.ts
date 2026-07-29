/**
 * Parse/serialize del `.adcsheet` (hoja de cálculo ADC).
 *
 * El archivo es JSON Lines, no un árbol JSON único: la primera línea es el
 * envelope y cada línea siguiente una fila — un array plano (`["a","b"]`) o un
 * bloque `{cells: […], …props}` si la fila tiene propiedades. Las celdas son
 * strings planos salvo que necesiten propiedades (`{v:"…", bg:"…"}`): un
 * archivo grande ocupa poco en disco y en memoria (sin un objeto por celda).
 * Propiedades desconocidas (fórmulas, colores futuros) se conservan tal cual.
 */

// Solo imports de tipos desde @common: un import de runtime haría que Stencil
// emita el .js transpilado junto a la fuente compartida (fuera de este árbol).
import type { AdcSheet, AdcSheetEnvelope, SheetCell, SheetCellBlock } from "@common/types/adc-sheet/index.js";

/** Hoja vacía lista para editar (la grilla crece desde el editor). */
export function emptyAdcSheet(title?: string): AdcSheet {
	return {
		envelope: { format: "adc-sheet", version: 1, ...(title ? { title } : {}) },
		rows: Array.from({ length: 10 }, () => ["", "", "", ""]),
		rowProps: [],
	};
}

/** Texto visible de una celda (string plano o bloque extendido). */
export function cellText(cell: SheetCell): string {
	return typeof cell === "string" ? cell : cell.v;
}

/** Reemplaza el texto conservando las propiedades del bloque (color, fórmula, …). */
export function withCellText(cell: SheetCell, text: string): SheetCell {
	return typeof cell === "string" ? text : { ...cell, v: text };
}

/** Texto de celda desde JSON: solo escalares razonables (lo demás queda vacío). */
function cellString(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return "";
}

/** Celda desde JSON: tolerante con tipos ajenos; los bloques conservan sus props. */
function coerceCell(raw: unknown): SheetCell {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const { v } = raw as { v?: unknown };
		return { ...(raw as Record<string, unknown>), v: cellString(v) } as SheetCellBlock;
	}
	return cellString(raw);
}

/** Envelope de la primera línea, o `null` si no es una hoja de cálculo ADC. */
function parseEnvelope(head: string): AdcSheetEnvelope | null {
	try {
		const raw = JSON.parse(head) as Partial<AdcSheetEnvelope> | null;
		if (!raw || typeof raw !== "object" || raw.format !== "adc-sheet" || typeof raw.version !== "number") return null;
		return raw as AdcSheetEnvelope;
	} catch {
		return null;
	}
}

/** Una línea de fila: array plano, bloque `{cells, …props}` o texto corrupto (no se pierde). */
function parseRowLine(line: string): { cells: SheetCell[]; props?: Record<string, unknown> } {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return { cells: [line] };
	}
	if (Array.isArray(raw)) return { cells: raw.map(coerceCell) };
	if (raw && typeof raw === "object") {
		const { cells, ...props } = raw as { cells?: unknown };
		return {
			cells: Array.isArray(cells) ? cells.map(coerceCell) : [],
			props: Object.keys(props).length > 0 ? props : undefined,
		};
	}
	return { cells: [coerceCell(raw)] };
}

/**
 * Parsea el contenido de un `.adcsheet`. Devuelve `null` si la primera línea
 * no es un envelope válido; las líneas de fila son tolerantes.
 */
export function parseAdcSheet(content: string): AdcSheet | null {
	const text = (content ?? "").replaceAll("\r\n", "\n");
	const headEnd = text.indexOf("\n");
	const envelope = parseEnvelope(headEnd === -1 ? text : text.slice(0, headEnd));
	if (!envelope) return null;

	const rows: SheetCell[][] = [];
	const rowProps: Array<Record<string, unknown> | undefined> = [];
	if (headEnd !== -1) {
		for (const line of text.slice(headEnd + 1).split("\n")) {
			if (!line.trim()) continue;
			const row = parseRowLine(line);
			rows.push(row.cells);
			rowProps.push(row.props);
		}
	}
	return { envelope, rows, rowProps };
}

/** Bloque `{v}` sin otras props degrada a string plano (más chico en disco). */
function cellForDisk(cell: SheetCell): SheetCell {
	if (typeof cell === "string") return cell;
	return Object.keys(cell).length === 1 ? cell.v : cell;
}

/** Serializa una hoja a JSON Lines (contenido del archivo `.adcsheet`). */
export function serializeAdcSheet(sheet: AdcSheet): string {
	const lines = [JSON.stringify(sheet.envelope)];
	for (let i = 0; i < sheet.rows.length; i++) {
		const cells = sheet.rows[i].map(cellForDisk);
		// Las celdas vacías al final no aportan nada: la lectura re-rectangula.
		let end = cells.length;
		while (end > 0 && cells[end - 1] === "") end--;
		const trimmed = cells.slice(0, end);
		const props = sheet.rowProps[i];
		lines.push(props ? JSON.stringify({ ...props, cells: trimmed }) : JSON.stringify(trimmed));
	}
	return lines.join("\n") + "\n";
}

// ── Export FODS (OpenDocument Spreadsheet plano, libre de derechos) ──────────

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapeXml(text: string): string {
	return text.replaceAll(/[&<>"]/g, (ch) => XML_ESCAPES[ch]);
}

/** Número "de planilla": entero o decimal con punto (los demás van como texto). */
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function fodsCell(cell: SheetCell): string {
	const text = cellText(cell);
	const formula = typeof cell === "object" && typeof cell.f === "string" ? ` table:formula="${escapeXml(cell.f)}"` : "";
	const value = NUMBER_RE.test(text.trim())
		? `office:value-type="float" office:value="${text.trim()}"`
		: `office:value-type="string"`;
	return `<table:table-cell ${value}${formula}><text:p>${escapeXml(text)}</text:p></table:table-cell>`;
}

/**
 * Serializa la grilla a `.fods` (Flat OpenDocument Spreadsheet 1.3): un único
 * XML que LibreOffice/OnlyOffice abren como planilla. Celdas numéricas van
 * tipadas como número; una celda con `f` conserva su fórmula.
 */
export function sheetToFods(rows: SheetCell[][], name = "Hoja 1"): string {
	const body = rows
		.map((row) => `<table:table-row>${row.map(fodsCell).join("")}</table:table-row>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:body><office:spreadsheet>
<table:table table:name="${escapeXml(name)}">
${body}
</table:table>
</office:spreadsheet></office:body></office:document>
`;
}
