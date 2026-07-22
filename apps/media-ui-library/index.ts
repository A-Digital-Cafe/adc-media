import { BaseApp } from "@apps/BaseApp.js";

/**
 * Media UI Library — visores y editores de documentos/multimedia (Stencil)
 * reutilizables desde cualquier app de la plataforma.
 */
export default class MediaUILibraryApp extends BaseApp {
	async run(): Promise<void> {
		this.logger.logOk(`${this.name} - Componentes de media listos para ser consumidos`);
	}
}
