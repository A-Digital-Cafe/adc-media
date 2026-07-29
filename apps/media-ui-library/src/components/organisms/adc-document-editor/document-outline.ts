/**
 * Esquema (índice navegable) y estadísticas del documento ADC: lo que hace
 * manejable editar libros o documentos largos sin scrollear a ciegas.
 *
 * El esquema se construye desde los bloques y se ancla al DOM por orden de
 * aparición (n-ésimo heading / n-ésima tabla del flujo del editor).
 */

import type { DocumentBlock } from "@common/types/adc-document/index.js";

export interface OutlineEntry {
	/** Tipo de ancla en el DOM del editor. */
	kind: "heading" | "table";
	/** Orden dentro de su tipo (n-ésimo heading o n-ésima tabla del flujo). */
	ordinal: number;
	/** Nivel de anidado para la sangría (2..6 en headings; 2 en tablas). */
	level: number;
	label: string;
	/** Página 1-based estimada por saltos de página (la real la calcula la paginación). */
	page: number;
}

/** Recorta el texto de una entrada del esquema para que no rompa la barra lateral. */
function trim(text: string, fallback: string): string {
	const clean = text.replaceAll(/\s+/g, " ").trim();
	if (!clean) return fallback;
	return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

/** Bloques en orden de documento, entrando en los contenedores con margen. */
export function flattenDocumentBlocks(blocks: DocumentBlock[]): DocumentBlock[] {
	const out: DocumentBlock[] = [];
	for (const block of blocks) {
		if (block.type === "margin-box") out.push(...flattenDocumentBlocks(block.blocks ?? []));
		else out.push(block);
	}
	return out;
}

/** Construye el índice: headings + tablas, en orden de documento. */
export function buildOutline(blocks: DocumentBlock[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	let page = 1;
	let headings = 0;
	let tables = 0;
	for (const block of flattenDocumentBlocks(blocks)) {
		if (block.type === "page-break") {
			page += 1;
		} else if (block.type === "heading") {
			entries.push({ kind: "heading", ordinal: headings, level: block.level, label: trim(block.text, "(sin título)"), page });
			headings += 1;
		} else if (block.type === "table" || block.type === "table-x") {
			entries.push({ kind: "table", ordinal: tables, level: 2, label: trim(block.caption ?? "", "Tabla"), page });
			tables += 1;
		}
	}
	return entries;
}

/** Páginas según saltos explícitos (estimación cuando no hay paginación medida). */
export function countPages(blocks: DocumentBlock[]): number {
	return flattenDocumentBlocks(blocks).filter((b) => b.type === "page-break").length + 1;
}

/** Texto contable de un bloque, sea cual sea su forma (`text`, `items`, `content`, `rows`). */
function blockText(block: Record<string, unknown>): string {
	if (typeof block.text === "string") return block.text;
	if (Array.isArray(block.items)) return block.items.join(" ");
	if (typeof block.content === "string") return block.content;
	if (Array.isArray(block.rows)) return (block.rows as string[][]).flat().join(" ");
	return "";
}

/** Cantidad de palabras del documento (aproximada: separa por espacios). */
export function countWords(blocks: DocumentBlock[]): number {
	let total = 0;
	for (const block of flattenDocumentBlocks(blocks)) {
		const words = blockText(block as unknown as Record<string, unknown>)
			.trim()
			.split(/\s+/)
			.filter(Boolean);
		total += words.length;
	}
	return total;
}
