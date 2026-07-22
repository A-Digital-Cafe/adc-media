import { Component, Prop } from "@stencil/core";

/**
 * Visor de PDF con el renderer nativo del navegador (sin dependencias).
 * Usa <object> para tener fallback declarativo cuando el navegador no puede
 * embeber el PDF (móviles antiguos, visores deshabilitados).
 *
 * La app consumidora debe permitir el embed en su CSP (frame-src / object-src).
 *
 * @example
 * <adc-pdf-viewer src="https://.../file.pdf" file-name="manual.pdf" />
 */
@Component({
	tag: "adc-pdf-viewer",
	shadow: false,
})
export class AdcPdfViewer {
	/** URL ya resuelta del PDF (presignada, proxy u object URL) */
	@Prop() src!: string;

	/** Nombre del archivo (accesibilidad y fallback) */
	@Prop() fileName?: string;

	/** Alto del visor (CSS value) */
	@Prop() height = "70vh";

	/** Texto del fallback cuando el navegador no puede embeber el PDF */
	@Prop() fallbackLabel?: string;

	/** Texto del enlace de apertura/descarga en el fallback */
	@Prop() downloadLabel?: string;

	render() {
		return (
			<object
				data={this.src}
				type="application/pdf"
				class="w-full rounded"
				style={{ height: this.height }}
				aria-label={this.fileName ?? "PDF"}
			>
				<div class="flex flex-col items-center gap-2 py-8 text-sm text-muted">
					{this.fallbackLabel && <span>{this.fallbackLabel}</span>}
					<a href={this.src} target="_blank" rel="noopener" class="text-accent underline">
						{this.downloadLabel ?? this.fileName ?? "PDF"}
					</a>
				</div>
			</object>
		);
	}
}
