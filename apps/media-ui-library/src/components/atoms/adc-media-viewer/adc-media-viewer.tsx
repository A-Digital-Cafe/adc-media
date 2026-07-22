import { Component, Event, Prop, State, Watch, type EventEmitter } from "@stencil/core";

export type MediaViewerType = "image" | "video" | "audio";

/**
 * Visor genérico de imagen / video / audio.
 * Recibe una URL ya resuelta (presignada, proxy u object URL) — no hace fetch
 * ni conoce el origen del archivo, para ser reutilizable desde cualquier app.
 *
 * @example
 * <adc-media-viewer src="https://..." media-type="image" file-name="foto.png" />
 */
@Component({
	tag: "adc-media-viewer",
	shadow: false,
})
export class AdcMediaViewer {
	/** URL ya resuelta del recurso */
	@Prop() src!: string;

	/** Tipo de medio a renderizar */
	@Prop() mediaType: MediaViewerType = "image";

	/** Nombre del archivo (usado como alt/title fallback) */
	@Prop() fileName?: string;

	/** Texto alternativo para imágenes */
	@Prop() alt?: string;

	/** Autoreproducir audio/video */
	@Prop() autoplay = false;

	/** Texto a mostrar si el recurso falla al cargar (el host decide el copy/i18n) */
	@Prop() errorLabel?: string;

	@State() failed = false;

	/** Emitido cuando el recurso falla al cargar */
	@Event() adcMediaError!: EventEmitter<void>;

	@Watch("src")
	handleSrcChange(): void {
		this.failed = false;
	}

	private readonly handleError = (): void => {
		this.failed = true;
		this.adcMediaError.emit();
	};

	render() {
		if (this.failed) {
			return <p class="text-danger text-sm py-8 text-center">{this.errorLabel ?? this.fileName ?? ""}</p>;
		}
		switch (this.mediaType) {
			case "video":
				return (
					<video
						src={this.src}
						controls
						autoplay={this.autoplay}
						class="max-h-[70vh] max-w-full mx-auto rounded"
						onError={this.handleError}
					/>
				);
			case "audio":
				return <audio src={this.src} controls autoplay={this.autoplay} class="w-full" onError={this.handleError} />;
			default:
				return (
					<img
						src={this.src}
						alt={this.alt ?? this.fileName ?? ""}
						class="max-h-[70vh] max-w-full mx-auto rounded"
						onError={this.handleError}
					/>
				);
		}
	}
}
