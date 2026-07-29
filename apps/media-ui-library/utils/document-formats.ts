/**
 * Registro de formatos de import/export del documento ADC.
 *
 * Agregar un formato = agregar una entrada acá (el editor construye su menú
 * "Exportar" y el `accept` del importador a partir de estas listas; no hay
 * botones ni ramas por formato en la UI).
 */

import type { AdcDocument } from "@common/types/adc-document/index.js";
import { docToMarkdown, markdownToDoc, docToPlainText, plainTextToDoc, docToHtml, csvToDoc, docTableToCsv } from "./doc-export.js";

export interface DocumentExportFormat {
	id: string;
	/** Etiqueta del item de menú. */
	label: string;
	/** Extensión del archivo generado (sin punto). */
	ext: string;
	mime: string;
	/** Contenido serializado, o `null` si el documento no aplica (ej: CSV sin tablas). */
	serialize: (doc: AdcDocument) => string | null;
	/** Abre el diálogo de impresión en vez de descargar (permite "Guardar como PDF"). */
	print?: boolean;
}

/** Tamaño de hoja tal como lo entiende `@page size`. */
const PAGE_SIZE_CSS: Record<string, string> = { a4: "A4", letter: "Letter", legal: "Legal" };

/** CSS de impresión: la geometría sale de la configuración de página del documento. */
function printStyles(doc: AdcDocument): string {
	const size = PAGE_SIZE_CSS[doc.page?.size ?? "a4"] ?? "A4";
	const m = doc.page?.margins ?? { top: 2, right: 2, bottom: 2, left: 2 };
	return `
	@page { size: ${size}; margin: ${m.top}cm ${m.right}cm ${m.bottom}cm ${m.left}cm; }
${PRINT_BODY_STYLES}`;
}

/** Tipografía y bloques: independientes del tamaño de hoja. */
const PRINT_BODY_STYLES = `
	body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.6; color: #111; margin: 0; }
	h1, h2, h3, h4, h5, h6 { font-family: Helvetica, Arial, sans-serif; line-height: 1.25; break-after: avoid; }
	table { border-collapse: collapse; width: 100%; break-inside: avoid; }
	th, td { border: 1px solid #999; padding: 0.35em 0.6em; text-align: left; }
	blockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 1em; color: #444; }
	pre { background: #f4f4f4; padding: 0.8em; overflow-x: auto; }
	img { max-width: 100%; }
`;

/** HTML autocontenido con estilos de impresión (base de "Imprimir / PDF"). */
function docToPrintableHtml(doc: AdcDocument): string {
	return docToHtml(doc).replace("</head>", `<style>${printStyles(doc)}</style>\n</head>`);
}

export const DOCUMENT_EXPORT_FORMATS: readonly DocumentExportFormat[] = [
	{ id: "print", label: "Imprimir / PDF…", ext: "html", mime: "text/html", serialize: docToPrintableHtml, print: true },
	{ id: "md", label: "Markdown (.md)", ext: "md", mime: "text/markdown", serialize: docToMarkdown },
	{ id: "txt", label: "Texto plano (.txt)", ext: "txt", mime: "text/plain", serialize: docToPlainText },
	{ id: "html", label: "Página web (.html)", ext: "html", mime: "text/html", serialize: docToPrintableHtml },
	{ id: "csv", label: "Tabla (.csv)", ext: "csv", mime: "text/csv", serialize: (doc) => docTableToCsv(doc) },
];

export interface DocumentImportFormat {
	id: string;
	/** Extensiones aceptadas (sin punto). */
	exts: readonly string[];
	parse: (text: string, title?: string) => AdcDocument;
}

export const DOCUMENT_IMPORT_FORMATS: readonly DocumentImportFormat[] = [
	{ id: "md", exts: ["md", "markdown"], parse: markdownToDoc },
	{ id: "csv", exts: ["csv"], parse: csvToDoc },
	{ id: "txt", exts: ["txt"], parse: plainTextToDoc },
];

/** Valor de `accept` para el `<input type="file">` de importación. */
export const DOCUMENT_IMPORT_ACCEPT = DOCUMENT_IMPORT_FORMATS.flatMap((f) => f.exts.map((ext) => `.${ext}`)).join(",");

/** Importa texto según la extensión del nombre (fallback: texto plano). */
export function importDocumentText(fileName: string, text: string, title?: string): AdcDocument {
	const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
	const format = DOCUMENT_IMPORT_FORMATS.find((f) => f.exts.includes(ext));
	return (format ?? { parse: plainTextToDoc }).parse(text, title);
}

/** Descarga un contenido de texto como archivo. */
export function downloadText(content: string, fileName: string, mime: string): void {
	const blob = new Blob([content], { type: `${mime};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	a.click();
	URL.revokeObjectURL(url);
}

/** Imprime un HTML en un iframe oculto (no abre pestañas ni pierde la edición). */
export function printHtml(html: string): void {
	const frame = document.createElement("iframe");
	frame.setAttribute("aria-hidden", "true");
	frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
	frame.srcdoc = html;
	frame.onload = () => {
		frame.contentWindow?.focus();
		frame.contentWindow?.print();
		// El diálogo de impresión es modal: al volver ya se puede descartar el iframe.
		setTimeout(() => frame.remove(), 1000);
	};
	document.body.appendChild(frame);
}
