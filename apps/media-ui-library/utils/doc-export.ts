/**
 * Import/export del documento ADC hacia formatos de texto libres:
 * Markdown (round-trip), texto plano (round-trip básico), HTML (solo export)
 * y CSV (tablas). Sin dependencias.
 */

import type { Block } from "@common/ADC/types/learning.js";
import type { AdcDocument, DocumentBlock } from "@common/types/adc-document/index.js";
import { markdownToBlocks, blocksToMarkdown } from "./markdown-blocks.js";
import { parseCsv, serializeCsv, type CsvDelimiter } from "./csv.js";

/** Marcador de salto de página en Markdown (round-trip de `page-break`). */
const PAGE_BREAK_MARKER = "<!-- page-break -->";

function isPlainBlock(block: DocumentBlock): block is Block {
	return block.type !== "page-break" && block.type !== "table-x" && block.type !== "margin-box";
}

/**
 * Aplana los contenedores con margen: los formatos de texto (Markdown, texto
 * plano, CSV) no tienen sangrías de página, así que sus bloques se emiten en
 * línea. HTML sí los conserva (ver `blockToHtml`).
 */
function flattenBlocks(blocks: DocumentBlock[]): DocumentBlock[] {
	const out: DocumentBlock[] = [];
	for (const block of blocks) {
		if (block.type === "margin-box") out.push(...flattenBlocks(block.blocks ?? []));
		else out.push(block);
	}
	return out;
}

/** Degrada bloques extendidos al `Block` canónico (para serializar con las utils de blocks). */
function degradeToPlain(block: DocumentBlock): Block | null {
	if (isPlainBlock(block)) return block;
	if (block.type === "table-x") {
		// Pierde colWidths/merges (limitación documentada del formato destino).
		return {
			type: "table",
			header: block.header,
			rows: block.rows,
			...(block.columnAlign ? { columnAlign: block.columnAlign } : {}),
			...(block.caption ? { caption: block.caption } : {}),
			...(block.rowHeaders ? { rowHeaders: block.rowHeaders } : {}),
		};
	}
	return null; // page-break: lo maneja cada serializador
}

// ── Markdown ────────────────────────────────────────────────────────────────

/** Exporta el documento a Markdown. `page-break` → marcador HTML-comment. */
export function docToMarkdown(doc: AdcDocument): string {
	const out: string[] = [];
	let pending: Block[] = [];
	const flush = () => {
		if (pending.length > 0) out.push(blocksToMarkdown(pending).trimEnd());
		pending = [];
	};
	for (const block of flattenBlocks(doc.blocks)) {
		if (block.type === "page-break") {
			flush();
			out.push(PAGE_BREAK_MARKER);
			continue;
		}
		const plain = degradeToPlain(block);
		if (plain) pending.push(plain);
	}
	flush();
	return out.join("\n\n") + "\n";
}

/** Importa Markdown como documento ADC (marcador de page-break → bloque). */
export function markdownToDoc(markdown: string, title?: string): AdcDocument {
	const blocks: DocumentBlock[] = [];
	for (const segment of markdown.split(PAGE_BREAK_MARKER)) {
		if (blocks.length > 0) blocks.push({ type: "page-break" });
		blocks.push(...markdownToBlocks(segment));
	}
	return {
		format: "adc-document",
		version: 1,
		...(title ? { title } : {}),
		blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
	};
}

// ── Texto plano ─────────────────────────────────────────────────────────────

function blockToPlainText(block: DocumentBlock): string {
	switch (block.type) {
		case "heading":
		case "paragraph":
		case "quote":
		case "callout":
			return block.text;
		case "checkbox":
			return `[${block.checked ? "x" : " "}] ${block.text}`;
		case "list":
			return block.items.map((item, i) => (block.ordered ? `${(block.start ?? 1) + i}. ${item}` : `- ${item}`)).join("\n");
		case "code":
			return block.content;
		case "table":
		case "table-x":
			return [block.header, ...block.rows].map((row) => row.join("\t")).join("\n");
		case "attachment":
			return block.fileName;
		case "divider":
			return "---";
		case "page-break":
			return "\f";
		case "margin-box":
			return block.blocks.map(blockToPlainText).join("\n\n");
		default:
			return "";
	}
}

/** Exporta el documento a texto plano (pierde estructura; page-break → form feed). */
export function docToPlainText(doc: AdcDocument): string {
	return flattenBlocks(doc.blocks).map(blockToPlainText).join("\n\n") + "\n";
}

/** Importa texto plano: párrafos separados por línea en blanco. */
export function plainTextToDoc(text: string, title?: string): AdcDocument {
	const blocks: DocumentBlock[] = text
		.replaceAll("\r\n", "\n")
		.split(/\n{2,}/)
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map((chunk) => ({ type: "paragraph" as const, text: chunk }));
	return {
		format: "adc-document",
		version: 1,
		...(title ? { title } : {}),
		blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
	};
}

// ── HTML (solo export) ──────────────────────────────────────────────────────

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function tableToHtml(header: string[], rows: string[][], caption?: string): string {
	const headersParsed = header.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
	const head = `<thead><tr>${headersParsed}</tr></thead>`;
	const rowsParsed = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
	const body = `<tbody>${rowsParsed}</tbody>`;
	const cap = caption ? `<caption>${escapeHtml(caption)}</caption>` : "";
	return `<table>${cap}${head}${body}</table>`;
}

function blockToHtml(block: DocumentBlock): string {
	switch (block.type) {
		case "heading":
			return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
		case "paragraph":
			return `<p>${escapeHtml(block.text).replaceAll("\n", "<br>")}</p>`;
		case "checkbox":
			return `<p><input type="checkbox" disabled${block.checked ? " checked" : ""}> ${escapeHtml(block.text)}</p>`;
		case "list": {
			const items = block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
			const possibleStart = block.start && block.start !== 1 ? ` start="${block.start}"` : "";
			return block.ordered ? `<ol${possibleStart}>${items}</ol>` : `<ul>${items}</ul>`;
		}
		case "code":
			return `<pre><code>${escapeHtml(block.content)}</code></pre>`;
		case "callout":
			return `<aside data-tone="${block.tone}"><p>${escapeHtml(block.text)}</p></aside>`;
		case "quote":
			return `<blockquote><p>${escapeHtml(block.text)}</p></blockquote>`;
		case "table":
			return tableToHtml(block.header, block.rows, block.caption);
		case "table-x":
			return tableToHtml(block.header, block.rows, block.caption);
		case "attachment":
			return `<p>[${escapeHtml(block.fileName)}]</p>`;
		case "divider":
			return "<hr>";
		case "page-break":
			return '<div style="break-after: page"></div>';
		case "margin-box":
			return `<div style="padding-left:${block.margin}cm;padding-right:${block.margin}cm">${block.blocks.map(blockToHtml).join("\n")}</div>`;
		default:
			return "";
	}
}

/** Exporta el documento a un HTML mínimo autocontenido. */
export function docToHtml(doc: AdcDocument): string {
	const title = escapeHtml(doc.title ?? "Documento");
	const body = doc.blocks.map(blockToHtml).join("\n");
	return `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

// ── CSV (tablas) ────────────────────────────────────────────────────────────

/** Importa un CSV como documento con una sola tabla extendida. */
export function csvToDoc(csv: string, title?: string): AdcDocument {
	const { rows } = parseCsv(csv);
	const [header = [], ...body] = rows;
	return {
		format: "adc-document",
		version: 1,
		...(title ? { title } : {}),
		blocks: [{ type: "table-x", header, rows: body }],
	};
}

/** Exporta la primera tabla del documento a CSV, o `null` si no hay tablas. */
export function docTableToCsv(doc: AdcDocument, delimiter: CsvDelimiter = ","): string | null {
	for (const block of flattenBlocks(doc.blocks)) {
		if (block.type === "table" || block.type === "table-x") {
			return serializeCsv([block.header, ...block.rows], delimiter);
		}
	}
	return null;
}
