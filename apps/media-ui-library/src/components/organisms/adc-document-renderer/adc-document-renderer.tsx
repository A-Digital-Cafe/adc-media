import { Component, Prop } from "@stencil/core";
import type { AdcDocument } from "@common/types/adc-document/index.js";
import { segmentDocumentBlocks, type DocumentSegment as Segment } from "./document-segments.js";

/**
 * Renderer de documentos ADC (`.adcdoc`): delega los bloques canónicos en
 * `adc-blocks-renderer` y renderiza los extendidos (saltos de página, tablas
 * extendidas). Solo lectura.
 */
@Component({
	tag: "adc-document-renderer",
	shadow: false,
})
export class AdcDocumentRenderer {
	/** Documento a renderizar */
	@Prop() doc?: AdcDocument;

	/** Map opcional `attachmentId -> url` para bloques attachment */
	@Prop() attachmentUrls: Record<string, string> = {};

	private renderSegment(segment: Segment, index: number) {
		if (segment.kind === "page-break") {
			return <hr key={index} class="adc-doc-page-break border-dashed border-surface-alt my-6" aria-label="Salto de página" />;
		}
		if (segment.kind === "margin-box") {
			const { margin, blocks } = segment.block;
			// El margen del bloque se suma al de la página (en pantalla y al imprimir).
			return (
				<div key={index} style={{ paddingLeft: `${margin}cm`, paddingRight: `${margin}cm` }}>
					{segmentDocumentBlocks(blocks ?? []).map((child, i) => this.renderSegment(child, i))}
				</div>
			);
		}
		if (segment.kind === "table-x") {
			const b = segment.block;
			return (
				<adc-table-block
					key={index}
					header={b.header}
					rows={b.rows}
					columnAlign={b.columnAlign}
					caption={b.caption}
					rowHeaders={b.rowHeaders}
				></adc-table-block>
			);
		}
		return <adc-blocks-renderer key={index} blocks={segment.blocks} attachmentUrls={this.attachmentUrls}></adc-blocks-renderer>;
	}

	render() {
		if (!this.doc) return null;
		return (
			<article class="flex flex-col gap-2">
				{this.doc.title && <h1 class="text-2xl font-bold text-text mb-2">{this.doc.title}</h1>}
				{segmentDocumentBlocks(this.doc.blocks).map((segment, i) => this.renderSegment(segment, i))}
			</article>
		);
	}
}
