/**
 * Parse/serialize del envelope `.adcdoc` (documento ADC): validación tolerante
 * con degradación forward-compatible de bloques desconocidos a `paragraph`.
 */

// Solo imports de tipos desde @common: un import de runtime haría que Stencil
// emita el .js transpilado junto a la fuente compartida (fuera de este árbol).
import type { AdcDocument, DocumentBlock } from "@common/types/adc-document/index.js";

/** Documento vacío listo para editar. */
export function emptyAdcDocument(title?: string): AdcDocument {
	return { format: "adc-document", version: 1, ...(title ? { title } : {}), blocks: [{ type: "paragraph", text: "" }] };
}

const KNOWN_TYPES = new Set([
	"margin-box",
	"heading",
	"paragraph",
	"checkbox",
	"list",
	"code",
	"callout",
	"quote",
	"table",
	"attachment",
	"divider",
	"page-break",
	"table-x",
]);

function degradeUnknown(block: unknown): DocumentBlock | null {
	if (!block || typeof block !== "object") return null;
	const b = block as { type?: unknown; text?: unknown };
	if (typeof b.type !== "string") return null;
	if (KNOWN_TYPES.has(b.type)) return block as DocumentBlock;
	// Bloque de una versión futura: degradar a párrafo con su texto (si tiene).
	return { type: "paragraph", text: typeof b.text === "string" ? b.text : `[${b.type}]` };
}

/**
 * Parsea el contenido de un `.adcdoc`. Devuelve `null` si no es un documento
 * ADC válido (JSON inválido o envelope de otro formato).
 */
export function parseAdcDocument(content: string): AdcDocument | null {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const doc = raw as Partial<AdcDocument>;
	if (doc.format !== "adc-document" || typeof doc.version !== "number") return null;
	const blocks = Array.isArray(doc.blocks) ? doc.blocks.map(degradeUnknown).filter((b): b is DocumentBlock => b !== null) : [];
	return {
		format: "adc-document",
		version: 1,
		...(typeof doc.title === "string" ? { title: doc.title } : {}),
		...(doc.meta && typeof doc.meta === "object" ? { meta: doc.meta } : {}),
		...(doc.page && typeof doc.page === "object" ? { page: doc.page } : {}),
		blocks: blocks.length > 0 ? blocks : emptyAdcDocument().blocks,
	};
}

/** Serializa el documento a JSON UTF-8 (contenido del archivo `.adcdoc`). */
export function serializeAdcDocument(doc: AdcDocument): string {
	return JSON.stringify(doc, null, "\t") + "\n";
}
