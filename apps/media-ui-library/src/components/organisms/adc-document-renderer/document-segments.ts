import type { Block } from "@common/ADC/types/learning.js";
import type { DocumentBlock } from "@common/types/adc-document/index.js";

export type TableXBlock = Extract<DocumentBlock, { type: "table-x" }>;

export type MarginBoxBlock = Extract<DocumentBlock, { type: "margin-box" }>;

export type DocumentSegment =
	| { kind: "plain"; blocks: Block[] }
	| { kind: "page-break" }
	| { kind: "table-x"; block: TableXBlock }
	| { kind: "margin-box"; block: MarginBoxBlock };

/** Agrupa los bloques del documento en tramos renderizables/editables. */
export function segmentDocumentBlocks(blocks: DocumentBlock[]): DocumentSegment[] {
	const segments: DocumentSegment[] = [];
	let plain: Block[] = [];
	const flush = () => {
		if (plain.length > 0) segments.push({ kind: "plain", blocks: plain });
		plain = [];
	};
	for (const block of blocks) {
		if (block.type === "page-break") {
			flush();
			segments.push({ kind: "page-break" });
		} else if (block.type === "table-x") {
			flush();
			segments.push({ kind: "table-x", block });
		} else if (block.type === "margin-box") {
			flush();
			segments.push({ kind: "margin-box", block });
		} else {
			plain.push(block);
		}
	}
	flush();
	return segments;
}

/** Aplana los tramos de vuelta a la lista de bloques del documento. */
export function segmentsToBlocks(segments: DocumentSegment[]): DocumentBlock[] {
	const blocks: DocumentBlock[] = [];
	for (const segment of segments) {
		if (segment.kind === "plain") blocks.push(...segment.blocks);
		else if (segment.kind === "page-break") blocks.push({ type: "page-break" });
		else blocks.push(segment.block);
	}
	return blocks;
}
