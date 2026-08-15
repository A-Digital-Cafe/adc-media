/**
 * Registro de formatos de exportación de la hoja de cálculo (el equivalente de
 * `document-formats.ts` para el editor de documentos). Agregar un formato =
 * agregar una entrada acá; el menú "Exportar" se arma solo.
 *
 * Todos los formatos salvo el nativo exportan **valores calculados**, no
 * fórmulas: un `.csv` o un `.html` que se manda por mail tiene que mostrar el
 * total, no `=SUM(B2:B9)`. El `.adcsheet` es el único que conserva las
 * fórmulas, porque es el archivo con el que se sigue trabajando.
 */

import type { AdcSheetEnvelope, SheetCell } from "@common/types/adc-sheet/index.js";
import { serializeAdcSheet, sheetToFods } from "./adcsheet.js";
import { serializeCsv, type CsvDelimiter } from "./csv.js";

/** Espejo del mime de `@common/types/adc-sheet` (acá sólo se importan tipos). */
const SHEET_FILE_MIME = "application/x-adc-sheet";

export interface SheetExportContext {
	/** Grilla con los valores ya calculados: lo que el usuario está viendo. */
	display: string[][];
	/** Celdas crudas, con sus fórmulas y propiedades. Sólo lo usa el formato nativo. */
	rows: SheetCell[][];
	rowProps: Array<Record<string, unknown> | undefined>;
	envelope: AdcSheetEnvelope;
	delimiter: CsvDelimiter;
	/** Nombre base del archivo y título del documento impreso. */
	title: string;
}

export interface SheetExportFormat {
	id: string;
	/** Etiqueta del item de menú. */
	label: string;
	/** Extensión del archivo generado (sin punto). */
	ext: string;
	mime: string;
	/** Abre el diálogo de impresión en vez de descargar (permite "Guardar como PDF"). */
	print?: boolean;
	serialize: (ctx: SheetExportContext) => string;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Estilos de la hoja exportada. Sin esto la tabla sale sin una sola línea: el
 * HTML pelado no dibuja bordes y una planilla impresa sin separadores no se
 * puede leer. Gris medio para que se vea en pantalla y no empaste al imprimir.
 */
const SHEET_HTML_STYLES = `
	@page { size: A4 landscape; margin: 1.2cm; }
	body { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; color: #111; margin: 0; }
	h1 { font-size: 14pt; margin: 0 0 0.6em; }
	table { border-collapse: collapse; width: 100%; }
	/* El separador de celdas: gris en todas, incluida la cabecera. */
	th, td { border: 1px solid #9a9a9a; padding: 0.3em 0.55em; text-align: left; vertical-align: top; }
	thead th { background: #ececec; font-weight: 600; }
	/* Los números se leen alineados a la derecha, como en cualquier planilla. */
	td.num { text-align: right; font-variant-numeric: tabular-nums; }
	tbody tr:nth-child(even) td { background: #fafafa; }
	/* Al imprimir, la cabecera se repite en cada hoja y ninguna fila se parte. */
	thead { display: table-header-group; }
	tr { break-inside: avoid; }
`;

/** Número "de planilla": el mismo criterio que usa el export a FODS. */
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function cellHtml(text: string): string {
	const numeric = NUMBER_RE.test(text.trim()) && text.trim() !== "";
	return `<td${numeric ? ' class="num"' : ""}>${escapeHtml(text)}</td>`;
}

/**
 * HTML autocontenido de la hoja: la primera fila va como cabecera (es como la
 * pinta el editor) y el resto como cuerpo. Sirve igual para "Exportar → HTML"
 * y para "Imprimir": el diálogo de impresión imprime este mismo documento.
 */
export function sheetToHtml(display: string[][], title: string): string {
	const [header = [], ...body] = display;
	const headHtml = header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");
	const bodyHtml = body.map((row) => `<tr>${row.map(cellHtml).join("")}</tr>`).join("\n");
	return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${SHEET_HTML_STYLES}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<table>
<thead><tr>${headHtml}</tr></thead>
<tbody>
${bodyHtml}
</tbody>
</table>
</body>
</html>
`;
}

/** Tabla Markdown de la grilla (primera fila = encabezado). */
function sheetToMarkdown(display: string[][]): string {
	const [header = [], ...body] = display;
	const escape = (cell: string) => cell.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");
	const lines = [`| ${header.map(escape).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
	for (const row of body) lines.push(`| ${row.map(escape).join(" | ")} |`);
	return lines.join("\n") + "\n";
}

export const SHEET_EXPORT_FORMATS: readonly SheetExportFormat[] = [
	{
		id: "print",
		label: "Imprimir / PDF… (Ctrl+P)",
		ext: "html",
		mime: "text/html",
		print: true,
		serialize: (ctx) => sheetToHtml(ctx.display, ctx.title),
	},
	{ id: "csv", label: "CSV (.csv)", ext: "csv", mime: "text/csv", serialize: (ctx) => serializeCsv(ctx.display, ctx.delimiter) },
	{
		id: "fods",
		label: "Planilla OpenDocument (.fods)",
		ext: "fods",
		mime: "application/vnd.oasis.opendocument.spreadsheet",
		serialize: (ctx) => sheetToFods(ctx.display, ctx.title),
	},
	{
		id: "adcsheet",
		label: "Hoja de cálculo ADC (.adcsheet)",
		ext: "adcsheet",
		mime: SHEET_FILE_MIME,
		// El único que guarda las fórmulas: es el formato con el que se sigue editando.
		serialize: (ctx) => serializeAdcSheet({ envelope: ctx.envelope, rows: ctx.rows, rowProps: ctx.rowProps }),
	},
	{ id: "md", label: "Tabla Markdown (.md)", ext: "md", mime: "text/markdown", serialize: (ctx) => sheetToMarkdown(ctx.display) },
	{ id: "html", label: "Página web (.html)", ext: "html", mime: "text/html", serialize: (ctx) => sheetToHtml(ctx.display, ctx.title) },
];
