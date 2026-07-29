import { Component, Element, Event, Host, Prop, State, Watch, type EventEmitter } from "@stencil/core";
import type { AdcDocument, DocumentBlock, PageSetup, PageSizeId } from "@common/types/adc-document/index.js";
import type { InsertBlockKind } from "../adc-blocks-editor/adc-blocks-editor";
import type { MenuBarItem, MenuBarMenu } from "../../molecules/adc-menu-bar/adc-menu-bar";
import {
	DOCUMENT_EXPORT_FORMATS,
	DOCUMENT_IMPORT_ACCEPT,
	downloadText,
	importDocumentText,
	printHtml,
	type DocumentExportFormat,
} from "../../../../utils/document-formats.js";
import { buildOutline, countPages, countWords, type OutlineEntry } from "./document-outline.js";
import {
	DEFAULT_PAGE_SETUP,
	PAGE_SIZES,
	marginRatios,
	offsetWithin,
	pageRatio,
	pageSetupOf,
	paginateFlow,
	type Pagination,
} from "./document-pagination.js";

/**
 * Vista del lienzo:
 * - `infinite`: flujo continuo, sin hojas (escritura rápida).
 * - `paged`: hojas con límites y márgenes, todas scrolleables.
 * - `single`: una hoja por vez, con anterior/siguiente.
 */
export type DocumentView = "infinite" | "paged" | "single";

const VIEW_LABELS: Record<DocumentView, string> = {
	infinite: "Continuo",
	paged: "Páginas",
	single: "Una página",
};

/** Menú "Insertar", agrupado por categoría (tabla y salto de página viven solo acá). */
const INSERT_MENU: MenuBarItem[] = [
	{
		label: "Texto",
		children: [
			{ label: "Párrafo", action: "insert:paragraph" },
			{ label: "Título 1", action: "insert:heading2" },
			{ label: "Título 2", action: "insert:heading3" },
			{ label: "Título 3", action: "insert:heading4" },
		],
	},
	{
		label: "Listas",
		children: [
			{ label: "Viñetas", action: "insert:list" },
			{ label: "Numerada", action: "insert:list-ordered" },
			{ label: "Casillas", action: "insert:checkbox" },
		],
	},
	{
		label: "Bloques",
		children: [
			{ label: "Cita", action: "insert:quote" },
			{ label: "Código", action: "insert:code" },
			{ label: "Destacado", action: "insert:callout" },
			{ label: "Divisor", action: "insert:divider" },
			{ label: "Bloque con margen", action: "insert:margin-box" },
		],
	},
	{
		label: "Página",
		children: [
			{ label: "Tabla", action: "insert:table" },
			{ label: "Salto de página", action: "insert:page-break" },
		],
	},
];

/** Máximo de estados guardados para deshacer/rehacer. */
const HISTORY_LIMIT = 60;
/** Espera antes de fotografiar el documento en el historial (agrupa el tecleo). */
const HISTORY_DEBOUNCE_MS = 700;
/** Espera antes de recalcular esquema, estadísticas y paginación. */
const DERIVED_DEBOUNCE_MS = 500;

/**
 * Editor de documentos ADC (`.adcdoc`): un único `adc-blocks-editor` con todo
 * el documento — las tablas y los saltos de página van embebidos en el flujo,
 * no como editores separados.
 *
 * Pensado para documentos largos (libros, informes): tres vistas de página
 * (continuo / hojas / una hoja con anterior-siguiente), esquema navegable,
 * historial de deshacer-rehacer y menús Archivo / Editar / Insertar.
 *
 * Emite `adcDocChange` con el documento completo en cada edición; el guardado
 * es responsabilidad del host (Drive u otra app).
 */
@Component({
	tag: "adc-document-editor",
	styleUrl: "adc-document-editor.css",
	shadow: false,
})
export class AdcDocumentEditor {
	/** Documento a editar */
	@Prop() doc?: AdcDocument;

	/** Solo lectura: delega en adc-document-renderer */
	@Prop() readonly = false;

	/** Map opcional `attachmentId -> url` para bloques attachment */
	@Prop() attachmentUrls: Record<string, string> = {};

	/**
	 * Ocupa el alto del contenedor (barra fija + esquema y lienzo con scroll
	 * propio). Requiere que el contenedor tenga altura definida (ej: modal a
	 * pantalla completa). Si es `false`, el editor crece con el contenido.
	 */
	@Prop() fill = false;

	/** Vista inicial del lienzo. */
	@Prop() view: DocumentView = "paged";

	@State() blocks: DocumentBlock[] = [];
	@State() title = "";
	/** Configuración de página del documento (tamaño de hoja + márgenes). */
	@State() page: PageSetup = DEFAULT_PAGE_SETUP;
	/** Panel "Configuración de página" abierto. */
	@State() pageSetupOpen = false;
	@State() outlineOpen = true;
	@State() currentView: DocumentView = "paged";
	/** Página visible en la vista `single` (0-based). */
	@State() currentPage = 0;
	/** Esquema y estadísticas: derivados de `blocks`, recalculados con debounce. */
	@State() outline: OutlineEntry[] = [];
	@State() stats: { words: number; pages: number } = { words: 0, pages: 1 };
	@State() pagination: Pagination = { starts: [0], pageHeight: 0 };

	@Element() host!: HTMLElement;

	/** Emitido en cada edición con el documento completo */
	@Event() adcDocChange!: EventEmitter<AdcDocument>;

	/** Passthrough del editor de bloques: el host abre el selector de archivo */
	@Event() adcRequestAttachment!: EventEmitter<{ kind: "image" | "file" }>;

	private fileInput?: HTMLInputElement;
	private canvasEl?: HTMLDivElement;
	private viewportEl?: HTMLDivElement;
	private sheetEl?: HTMLDivElement;
	private derivedTimer?: ReturnType<typeof setTimeout>;
	private historyTimer?: ReturnType<typeof setTimeout>;
	private resizeObserver?: ResizeObserver;
	/** Historial de deshacer/rehacer sobre instantáneas del documento. */
	private past: Array<{ title: string; blocks: DocumentBlock[] }> = [];
	private future: Array<{ title: string; blocks: DocumentBlock[] }> = [];
	/** Evita que una edición aplicada por deshacer/rehacer vuelva a apilarse. */
	private restoring = false;

	componentWillLoad(): void {
		this.currentView = this.view;
		this.syncFromDoc();
		// El esquema ocupa espacio: en pantallas angostas arranca plegado.
		this.outlineOpen = globalThis.innerWidth > 1024;
	}

	componentDidLoad(): void {
		// La geometría de las hojas depende del ancho disponible.
		this.resizeObserver = new ResizeObserver(() => this.refreshDerived());
		if (this.canvasEl) this.resizeObserver.observe(this.canvasEl);
		this.refreshDerived(true);
	}

	disconnectedCallback(): void {
		if (this.derivedTimer) clearTimeout(this.derivedTimer);
		if (this.historyTimer) clearTimeout(this.historyTimer);
		this.resizeObserver?.disconnect();
	}

	@Watch("doc")
	handleDocChange(): void {
		this.syncFromDoc();
	}

	@Watch("view")
	handleViewProp(): void {
		this.currentView = this.view;
	}

	@Watch("currentView")
	handleViewChange(): void {
		this.currentPage = 0;
		this.refreshDerived(true);
	}

	private syncFromDoc(): void {
		const doc = this.doc;
		this.title = doc?.title ?? "";
		this.page = pageSetupOf(doc?.page);
		this.blocks = doc?.blocks?.length ? doc.blocks : [{ type: "paragraph", text: "" }];
		this.past = [];
		this.future = [];
		this.refreshDerived(true);
	}

	private currentDoc(): AdcDocument {
		return {
			format: "adc-document",
			version: 1,
			...(this.title.trim() ? { title: this.title.trim() } : {}),
			...(this.doc?.meta ? { meta: this.doc.meta } : {}),
			page: this.page,
			blocks: this.blocks,
		};
	}

	/** Cambia la configuración de página (repagina y avisa al host para guardar). */
	private applyPageSetup(next: PageSetup): void {
		this.page = next;
		this.refreshDerived(true);
		this.emitChange();
	}

	private emitChange(): void {
		this.adcDocChange.emit(this.currentDoc());
	}

	/** Aplica una edición: historial + derivados + evento. */
	private applyEdit(blocks: DocumentBlock[], title = this.title): void {
		if (!this.restoring) this.pushHistory({ title: this.title, blocks: this.blocks });
		this.blocks = blocks;
		this.title = title;
		this.refreshDerived();
		this.emitChange();
	}

	// ── Historial ───────────────────────────────────────────────────────────

	/**
	 * Apila el estado previo agrupando ráfagas de tecleo (debounce). Una
	 * edición real SIEMPRE invalida el redo, aunque caiga dentro de la ráfaga.
	 */
	private pushHistory(snapshot: { title: string; blocks: DocumentBlock[] }): void {
		if (this.historyTimer) clearTimeout(this.historyTimer);
		else this.past = [...this.past.slice(-(HISTORY_LIMIT - 1)), snapshot];
		this.future = [];
		this.historyTimer = setTimeout(() => (this.historyTimer = undefined), HISTORY_DEBOUNCE_MS);
	}

	/** Cierra el grupo de tecleo en curso: el próximo pushHistory vuelve a snapshotear. */
	private closeHistoryGroup(): void {
		if (!this.historyTimer) return;
		clearTimeout(this.historyTimer);
		this.historyTimer = undefined;
	}

	private undo(): void {
		const previous = this.past.pop();
		if (!previous) return;
		this.closeHistoryGroup();
		this.future = [...this.future, { title: this.title, blocks: this.blocks }];
		this.restoring = true;
		this.blocks = previous.blocks;
		this.title = previous.title;
		this.restoring = false;
		this.refreshDerived(true);
		this.emitChange();
	}

	private redo(): void {
		const next = this.future.pop();
		if (!next) return;
		this.closeHistoryGroup();
		this.past = [...this.past, { title: this.title, blocks: this.blocks }];
		this.restoring = true;
		this.blocks = next.blocks;
		this.title = next.title;
		this.restoring = false;
		this.refreshDerived(true);
		this.emitChange();
	}

	// ── Derivados (esquema, estadísticas, paginación) ───────────────────────

	/**
	 * Recalcula esquema, estadísticas y paginación. Recorren el documento entero
	 * y miden el DOM: con debounce para que escribir no los dispare en cada tecla.
	 */
	private refreshDerived(immediate = false): void {
		if (this.derivedTimer) clearTimeout(this.derivedTimer);
		const run = () => {
			this.derivedTimer = undefined;
			this.outline = buildOutline(this.blocks);
			this.repaginate();
			this.stats = {
				words: countWords(this.blocks),
				pages: this.currentView === "infinite" ? countPages(this.blocks) : this.pagination.starts.length,
			};
		};
		if (immediate) requestAnimationFrame(run);
		else this.derivedTimer = setTimeout(run, DERIVED_DEBOUNCE_MS);
	}

	private async flowRoot(): Promise<HTMLElement | null> {
		const editor = this.host.querySelector("adc-blocks-editor") as (HTMLElement & { getFlowRoot?: () => Promise<HTMLElement | null> }) | null;
		if (!editor) return null;
		await (editor as HTMLElement & { componentOnReady?: () => Promise<unknown> }).componentOnReady?.();
		return (await editor.getFlowRoot?.()) ?? null;
	}

	/** Configuración de página efectiva del documento. */
	private setup(): PageSetup {
		return pageSetupOf(this.page);
	}

	/** Mide el flujo y reparte los bloques en hojas (o las deshace en vista continua). */
	private repaginate(): void {
		void this.flowRoot().then((root) => {
			if (!root || !this.sheetEl) return;
			const setup = this.setup();
			const width = this.sheetEl.clientWidth;
			const paged = this.currentView !== "infinite" && width > 0;
			this.pagination = paginateFlow(root, this.sheetEl, paged ? width * pageRatio(setup) : 0, setup);
			this.currentPage = Math.min(this.currentPage, this.pagination.starts.length - 1);
			requestAnimationFrame(() => this.showCurrentPage());
		});
	}

	// ── Edición ─────────────────────────────────────────────────────────────

	private async insertBlock(kind: InsertBlockKind): Promise<void> {
		const editor = this.host.querySelector("adc-blocks-editor") as (HTMLElement & { insertBlock?: (k: InsertBlockKind) => Promise<void> }) | null;
		await editor?.insertBlock?.(kind);
	}

	private importFile(file: File): void {
		void file.text().then((text) => {
			const doc = importDocumentText(file.name, text, this.title || undefined);
			this.applyEdit(doc.blocks, doc.title ?? this.title);
		});
	}

	private exportAs(format: DocumentExportFormat): void {
		const content = format.serialize(this.currentDoc());
		if (content === null) return;
		if (format.print) printHtml(content);
		else downloadText(content, `${this.title.trim() || "documento"}.${format.ext}`, format.mime);
	}

	/** Formatos aplicables al documento actual (ej: CSV solo si hay tablas). */
	private availableExports(): DocumentExportFormat[] {
		const doc = this.currentDoc();
		return DOCUMENT_EXPORT_FORMATS.filter((format) => format.serialize(doc) !== null);
	}

	// ── Menús ───────────────────────────────────────────────────────────────

	private fileMenuItems(): MenuBarItem[] {
		return [
			{ label: "Configuración de página…", action: "file:page-setup" },
			{ label: "Importar archivo…", action: "file:import" },
			{ label: "Exportar…", children: this.availableExports().map((f) => ({ label: f.label, action: `export:${f.id}` })) },
		];
	}

	private editMenuItems(): MenuBarItem[] {
		return [
			{ label: this.past.length ? "Deshacer (Ctrl+Z)" : "Deshacer", action: "edit:undo" },
			{ label: this.future.length ? "Rehacer (Ctrl+Y)" : "Rehacer", action: "edit:redo" },
			{ label: "Seleccionar todo el texto", action: "edit:select-all" },
		];
	}

	/** Menús de la barra compartida (misma barra que el editor de hojas de cálculo). */
	private barMenus(): MenuBarMenu[] {
		return [
			{ label: "Archivo", items: () => this.fileMenuItems() },
			{ label: "Editar", items: () => this.editMenuItems() },
			{ label: "Insertar", items: INSERT_MENU },
		];
	}

	private handleMenuSelect(action: string): void {
		const [group, value] = action.split(":");
		if (group === "insert") {
			void this.insertBlock(value as InsertBlockKind);
			return;
		}
		if (group === "export") {
			const format = DOCUMENT_EXPORT_FORMATS.find((f) => f.id === value);
			if (format) this.exportAs(format);
			return;
		}
		if (group === "file" && value === "import") this.fileInput?.click();
		if (group === "file" && value === "page-setup") this.pageSetupOpen = true;
		if (group === "view") this.currentView = value as DocumentView;
		if (group === "edit") this.runEditAction(value);
	}

	private runEditAction(value: string): void {
		if (value === "undo") this.undo();
		else if (value === "redo") this.redo();
		else if (value === "select-all") {
			void this.flowRoot().then((root) => {
				if (!root) return;
				root.focus();
				const range = document.createRange();
				range.selectNodeContents(root);
				const sel = globalThis.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			});
		}
	}

	private readonly handleKeyDown = (ev: KeyboardEvent) => {
		if (!(ev.ctrlKey || ev.metaKey)) return;
		const key = ev.key.toLowerCase();
		const redo = key === "y" || (key === "z" && ev.shiftKey);
		if (redo) {
			ev.preventDefault();
			this.redo();
		} else if (key === "z") {
			ev.preventDefault();
			this.undo();
		}
	};

	// ── Navegación ──────────────────────────────────────────────────────────

	/** Navega a una entrada del esquema (heading o tabla n-ésima del flujo). */
	private scrollToOutline(entry: OutlineEntry): void {
		void this.flowRoot().then((root) => {
			const selector = entry.kind === "heading" ? "h2, h3, h4, h5, h6" : "table";
			const target = root?.querySelectorAll<HTMLElement>(selector)[entry.ordinal];
			if (!target) return;
			// En vista de una hoja, "scrollear" es cambiar de página.
			if (this.currentView === "single") this.goToPage(this.pageOf(target));
			else target.scrollIntoView({ block: "start", behavior: "smooth" });
		});
	}

	/** Página (0-based) en la que cae un elemento del flujo. */
	private pageOf(el: HTMLElement): number {
		if (!this.sheetEl) return 0;
		const top = offsetWithin(el, this.sheetEl) + this.sheetEl.scrollTop;
		const starts = this.pagination.starts;
		for (let i = starts.length - 1; i >= 0; i--) {
			if (top >= starts[i]) return i;
		}
		return 0;
	}

	private goToPage(index: number): void {
		const max = this.pagination.starts.length - 1;
		this.currentPage = Math.min(Math.max(0, index), max);
		this.showCurrentPage();
	}

	/** Coloca la ventana de la vista `single` sobre la hoja actual. */
	private showCurrentPage(): void {
		if (this.currentView !== "single" || !this.viewportEl) return;
		this.viewportEl.scrollTop = this.pagination.starts[this.currentPage] ?? 0;
	}

	// ── Render ──────────────────────────────────────────────────────────────

	private renderToolbar() {
		const { words, pages } = this.stats;
		return [
			// El título vive acá, fuera del papel: en la hoja solo va el contenido.
			<div key="toolbar-title" class="adc-editor-toolbar adc-doc__toolbar--title">
				<input
					class="adc-doc__title"
					placeholder="Título del documento"
					value={this.title}
					onInput={(ev: InputEvent) => this.applyEdit(this.blocks, (ev.target as HTMLInputElement).value)}
				/>
				<select
					class="adc-doc__select"
					aria-label="Vista del documento"
					onChange={(ev: globalThis.Event) => (this.currentView = (ev.target as HTMLSelectElement).value as DocumentView)}
				>
					{(Object.keys(VIEW_LABELS) as DocumentView[]).map((mode) => (
						<option key={mode} value={mode} selected={this.currentView === mode}>
							{VIEW_LABELS[mode]}
						</option>
					))}
				</select>
				<span class="text-xs text-muted whitespace-nowrap">
					{words} palabra{words === 1 ? "" : "s"} · {pages} pág.
				</span>
			</div>,
			<div key="toolbar-menus" class="adc-editor-toolbar">
				<button
					type="button"
					class="adc-menu-bar__btn"
					aria-pressed={String(this.outlineOpen)}
					title="Mostrar/ocultar el esquema del documento"
					onClick={() => (this.outlineOpen = !this.outlineOpen)}
				>
					☰ Esquema
				</button>
				<span class="adc-doc__sep"></span>
				<adc-menu-bar
					menus={this.barMenus()}
					onAdcMenuBarSelect={(ev: CustomEvent<{ action: string }>) => this.handleMenuSelect(ev.detail.action)}
				></adc-menu-bar>
				<input
					type="file"
					accept={DOCUMENT_IMPORT_ACCEPT}
					class="hidden"
					ref={(el) => (this.fileInput = el)}
					onChange={(ev: globalThis.Event) => {
						const input = ev.target as HTMLInputElement;
						const file = input.files?.[0];
						if (file) this.importFile(file);
						input.value = "";
					}}
				/>
				<span class="flex-1"></span>
				{this.currentView === "single" && this.renderPager()}
			</div>,
		];
	}

	private renderPager() {
		const total = this.pagination.starts.length;
		return (
			<span class="inline-flex items-center gap-1">
				<button type="button" class="adc-menu-bar__btn" disabled={this.currentPage === 0} onClick={() => this.goToPage(this.currentPage - 1)}>
					‹
				</button>
				<span class="text-xs text-muted whitespace-nowrap">
					Página {this.currentPage + 1} de {total}
				</span>
				<button
					type="button"
					class="adc-menu-bar__btn"
					disabled={this.currentPage >= total - 1}
					onClick={() => this.goToPage(this.currentPage + 1)}
				>
					›
				</button>
			</span>
		);
	}

	private renderOutline() {
		return (
			<nav class="adc-doc__outline" aria-label="Esquema del documento">
				{this.outline.length === 0 ? (
					<p class="px-2 text-xs text-muted">Agregá títulos para navegar el documento desde acá.</p>
				) : (
					<ul class="flex flex-col gap-0.5">
						{this.outline.map((entry) => (
							<li key={`${entry.kind}-${entry.ordinal}`}>
								<button
									type="button"
									class="adc-doc__outline-item"
									style={{ paddingLeft: `${0.5 + (entry.level - 2) * 0.75}rem` }}
									title={entry.label}
									onClick={() => this.scrollToOutline(entry)}
								>
									<span class="truncate">{entry.label}</span>
									<span class="ml-auto shrink-0 text-xs text-muted">{entry.page}</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</nav>
		);
	}

	/** Panel de configuración de página: tamaño de hoja y márgenes (en cm). */
	private renderPageSetup() {
		const setup = this.setup();
		const sides: Array<{ key: keyof PageSetup["margins"]; label: string }> = [
			{ key: "top", label: "Superior" },
			{ key: "bottom", label: "Inferior" },
			{ key: "left", label: "Izquierdo" },
			{ key: "right", label: "Derecho" },
		];
		return (
			<adc-modal open size="sm" modalTitle="Configuración de página" onAdcClose={() => (this.pageSetupOpen = false)}>
				<div class="flex flex-col gap-3">
				<label class="adc-doc__panel-row">
					<span class="w-24">Tamaño</span>
					<select
						class="adc-doc__select flex-1"
						onChange={(ev: globalThis.Event) =>
							this.applyPageSetup({ ...setup, size: (ev.target as HTMLSelectElement).value as PageSizeId })
						}
					>
						{(Object.keys(PAGE_SIZES) as PageSizeId[]).map((id) => (
							<option key={id} value={id} selected={setup.size === id}>
								{PAGE_SIZES[id].label}
							</option>
						))}
					</select>
				</label>
				<div class="adc-doc__panel-row">Márgenes (cm)</div>
				<div class="adc-doc__panel-grid">
					{sides.map((side) => (
						<label key={side.key} class="adc-doc__panel-row">
							<span class="w-20 text-xs text-muted">{side.label}</span>
							<input
								type="number"
								class="adc-doc__select w-20"
								min="0"
								max="8"
								step="0.5"
								value={setup.margins[side.key]}
								onChange={(ev: globalThis.Event) => {
									const cm = Number((ev.target as HTMLInputElement).value);
									if (!Number.isFinite(cm)) return;
									const margins = { ...setup.margins, [side.key]: Math.min(8, Math.max(0, cm)) };
									this.applyPageSetup({ ...setup, margins });
								}}
							/>
						</label>
					))}
					</div>
				</div>
			</adc-modal>
		);
	}

	/** Hojas de fondo: dibujan los límites y márgenes de página detrás del texto. */
	private renderSheets() {
		if (this.currentView === "infinite" || this.pagination.pageHeight <= 0) return null;
		return (
			<div class="adc-doc__sheets" aria-hidden="true">
				{this.pagination.starts.map((start) => (
					<div key={start} class="adc-doc__sheet" style={{ top: `${start}px`, height: `${this.pagination.pageHeight}px` }}></div>
				))}
			</div>
		);
	}

	render() {
		if (this.readonly) {
			return <adc-document-renderer doc={this.currentDoc()} attachmentUrls={this.attachmentUrls}></adc-document-renderer>;
		}
		const paged = this.currentView !== "infinite";
		const single = this.currentView === "single";
		const pageHeight = this.pagination.pageHeight;
		// Márgenes del papel: se aplican como padding SOLO al flujo del editor (no
		// a su barra, que pertenece a la pantalla) vía variables CSS. El padding en
		// % se resuelve contra el ancho, así que el superior se convierte con la
		// proporción de la hoja (cm de alto → fracción del ancho).
		const setup = this.setup();
		const ratios = marginRatios(setup);
		const contentStyle = paged
			? {
					"--doc-margin-left": `${ratios.left * 100}%`,
					"--doc-margin-right": `${ratios.right * 100}%`,
					"--doc-margin-top": `${ratios.top * pageRatio(setup) * 100}%`,
				}
			: {};
		// Vista de una hoja: ventana del alto de una hoja; el scroll lo maneja el
		// paginador (anterior/siguiente), no la rueda.
		const viewportStyle = single && pageHeight > 0 ? { height: `${pageHeight + 8}px`, overflow: "hidden" } : {};
		return (
			<Host class={this.fill ? "block h-full min-h-0" : ""}>
				<div class={`flex flex-col ${this.fill ? "h-full min-h-0" : ""}`} onKeyDown={this.handleKeyDown}>
					{this.renderToolbar()}
					<div class={`flex ${this.fill ? "min-h-0 flex-1" : ""}`}>
						{this.outlineOpen && this.renderOutline()}
						<div
							class={`adc-doc__canvas ${paged ? "adc-doc__canvas--paged" : ""} ${this.fill ? "min-h-0 overflow-y-auto" : ""}`}
							ref={(el) => (this.canvasEl = el)}
						>
							<div class="adc-doc__viewport" style={viewportStyle} ref={(el) => (this.viewportEl = el)}>
								<div class="adc-doc__sheet-stack" ref={(el) => (this.sheetEl = el)}>
									{this.renderSheets()}
									<div class="adc-doc__content" style={contentStyle}>
										<adc-blocks-editor
											blocks={this.blocks}
											attachmentUrls={this.attachmentUrls}
											maxLength={2000000}
											minHeight={200}
											stickyToolbar
											bare={paged}
											placeholder="Escribí tu documento…"
											onAdcBlocksChange={(ev: CustomEvent<DocumentBlock[]>) => this.applyEdit(ev.detail)}
											onAdcRequestAttachment={(ev: CustomEvent<{ kind: "image" | "file" }>) => this.adcRequestAttachment.emit(ev.detail)}
										></adc-blocks-editor>
									</div>
								</div>
							</div>
						</div>
					</div>
					{this.pageSetupOpen && this.renderPageSetup()}
				</div>
			</Host>
		);
	}
}
