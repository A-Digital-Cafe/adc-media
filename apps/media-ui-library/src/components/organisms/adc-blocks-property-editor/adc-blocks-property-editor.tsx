import { Component, Element, Event, Prop, State, Watch, type EventEmitter } from "@stencil/core";
import type { Block } from "@common/ADC/types/learning.js";
import { registerBlocksClipboard, isEditableTarget } from "../../../../utils/blocks-clipboard.js";
import { BlockPropertyFields, BLOCK_TYPE_OPTIONS } from "./blocks-property-fields.js";

/**
 * Editor de bloques por formulario (port Stencil del admin BlocksEditor de
 * community-home): lista de bloques con insertar/mover/borrar, edición por
 * propiedades y modo JSON crudo. Pensado para paneles de administración.
 *
 * Contrato: prop `value` = JSON del array de bloques; evento `adcBlocksChange`
 * con `{ json, blocks }` en cada edición.
 */
@Component({
	tag: "adc-blocks-property-editor",
	shadow: false,
})
export class AdcBlocksPropertyEditor {
	/** JSON del array de bloques (contrato de entrada) */
	@Prop() value: string = "";

	@State() blocks: Block[] = [];
	@State() parseError = "";
	@State() editingIndex: number | null = null;
	@State() insertAt: number | null = null;
	@State() showJson = false;
	@State() jsonDraft = "";

	/** Emitido en cada edición con el JSON serializado y los bloques parseados */
	@Event() adcBlocksChange!: EventEmitter<{ json: string; blocks: Block[] }>;

	@Element() host!: HTMLElement;

	private skipSync = false;
	private clipboardCleanup: (() => void) | null = null;

	componentWillLoad(): void {
		this.syncFromValue();
	}

	componentDidLoad(): void {
		// Portapapeles en 3 formatos: copiar todos los bloques (sin selección de
		// texto activa) y pegar bloques al final. No interfiere con inputs.
		this.clipboardCleanup = registerBlocksClipboard<Block>(this.host, {
			getBlocks: (ev) => {
				if (isEditableTarget(ev.target)) return null;
				const sel = globalThis.getSelection();
				if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return null;
				return this.blocks.length > 0 ? this.blocks : null;
			},
			onPaste: (payload, ev) => {
				if (isEditableTarget(ev.target)) return;
				if (!payload.blocks || payload.blocks.length === 0) return;
				ev.preventDefault();
				this.commit([...this.blocks, ...payload.blocks]);
				return true;
			},
		});
	}

	disconnectedCallback(): void {
		this.clipboardCleanup?.();
		this.clipboardCleanup = null;
	}

	@Watch("value")
	handleValueChange(): void {
		if (this.skipSync) {
			this.skipSync = false;
			return;
		}
		if (this.value === AdcBlocksPropertyEditor.serialize(this.blocks)) return;
		this.syncFromValue();
	}

	private static parseBlocks(text: string): { blocks: Block[]; error: string } {
		const trimmed = text.trim();
		if (!trimmed) return { blocks: [], error: "" };
		try {
			const parsed = JSON.parse(trimmed);
			if (!Array.isArray(parsed)) return { blocks: [], error: "El JSON debe ser un array" };
			return { blocks: parsed as Block[], error: "" };
		} catch (e) {
			return { blocks: [], error: e instanceof Error ? e.message : "JSON inválido" };
		}
	}

	private static serialize(blocks: Block[]): string {
		return blocks.length ? JSON.stringify(blocks, null, 2) : "";
	}

	private syncFromValue(): void {
		const { blocks, error } = AdcBlocksPropertyEditor.parseBlocks(this.value);
		this.parseError = error;
		if (!error) this.blocks = blocks;
		this.jsonDraft = this.value;
	}

	private commit(next: Block[]): void {
		this.skipSync = true;
		this.blocks = next;
		const json = AdcBlocksPropertyEditor.serialize(next);
		this.jsonDraft = json;
		this.parseError = "";
		this.adcBlocksChange.emit({ json, blocks: next });
	}

	private insert(type: Block["type"], at: number): void {
		const spec = BLOCK_TYPE_OPTIONS.find((t) => t.type === type);
		if (!spec) return;
		const next = [...this.blocks];
		next.splice(at, 0, spec.create());
		this.commit(next);
		this.insertAt = null;
		this.editingIndex = at;
	}

	private updateBlock(index: number, block: Block): void {
		this.commit(this.blocks.map((x, i) => (i === index ? block : x)));
	}

	private move(index: number, dir: -1 | 1): void {
		const target = index + dir;
		if (target < 0 || target >= this.blocks.length) return;
		const next = [...this.blocks];
		[next[index], next[target]] = [next[target], next[index]];
		this.commit(next);
		if (this.editingIndex === index) this.editingIndex = target;
	}

	private remove(index: number): void {
		this.commit(this.blocks.filter((_, i) => i !== index));
		if (this.editingIndex === index) this.editingIndex = null;
	}

	private applyJsonDraft(): void {
		const { blocks, error } = AdcBlocksPropertyEditor.parseBlocks(this.jsonDraft);
		this.parseError = error;
		if (!error) this.commit(blocks);
	}

	// ── Render ──────────────────────────────────────────────────────────────

	private renderTypeMenu(at: number) {
		return (
			<div class="rounded-xxl border border-surface-alt bg-surface shadow-lg p-2 grid grid-cols-2 gap-1 min-w-72" role="menu">
				{BLOCK_TYPE_OPTIONS.map((t) => (
					<button
						key={t.type}
						type="button"
						role="menuitem"
						class="flex items-center gap-2 px-3 py-2 rounded-xxl text-left text-sm hover:bg-surface-alt transition-colors"
						onClick={() => this.insert(t.type, at)}
					>
						<span class="inline-flex w-7 h-7 items-center justify-center rounded-md border border-surface-alt font-mono text-xs">
							{t.icon}
						</span>
						<span>{t.label}</span>
					</button>
				))}
			</div>
		);
	}

	private renderInsertSlot(at: number) {
		const open = this.insertAt === at;
		return (
			<div class="relative group h-2 my-1">
				<button
					type="button"
					aria-label="Insertar bloque aquí"
					class={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 top-1/2 w-6 h-6 rounded-full border border-surface-alt bg-surface text-sm flex items-center justify-center transition-opacity shadow-sm ${
						open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
					}`}
					onClick={() => (this.insertAt = open ? null : at)}
				>
					+
				</button>
				{open && <div class="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-10">{this.renderTypeMenu(at)}</div>}
			</div>
		);
	}

	private renderIconBtn(label: string, glyph: string, onClick: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) {
		return (
			<button
				type="button"
				aria-label={label}
				title={label}
				disabled={opts.disabled}
				class={`w-7 h-7 rounded-md border border-surface-alt bg-surface text-sm flex items-center justify-center transition-opacity hover:bg-surface-alt disabled:opacity-30 ${opts.danger ? "text-danger" : ""}`}
				onClick={onClick}
			>
				{glyph}
			</button>
		);
	}

	private renderBlockRow(block: Block, index: number) {
		const editing = this.editingIndex === index;
		return (
			<div key={`block-${index}`}>
				<div class={`group relative rounded-xxl ${editing ? "ring-1 ring-surface-alt bg-surface-alt/20" : "hover:bg-surface-alt/10"}`}>
					<div class="absolute right-2 top-2 z-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
						{this.renderIconBtn("Mover arriba", "↑", () => this.move(index, -1), { disabled: index === 0 })}
						{this.renderIconBtn("Mover abajo", "↓", () => this.move(index, 1), { disabled: index === this.blocks.length - 1 })}
						{this.renderIconBtn(editing ? "Cerrar edición" : "Editar bloque", editing ? "✕" : "✎", () => {
							this.editingIndex = editing ? null : index;
						})}
						{this.renderIconBtn("Eliminar bloque", "🗑", () => this.remove(index), { danger: true })}
					</div>
					<button
						type="button"
						class="w-full text-left p-2 cursor-pointer"
						aria-label="Editar bloque"
						onClick={() => (this.editingIndex = editing ? null : index)}
					>
						<adc-blocks-renderer blocks={[block]}></adc-blocks-renderer>
					</button>
					{editing && (
						<div class="border-t border-surface-alt p-3 bg-surface rounded-b-xxl">
							<BlockPropertyFields block={block} onPatch={(next) => this.updateBlock(index, next)} />
						</div>
					)}
				</div>
				{this.renderInsertSlot(index + 1)}
			</div>
		);
	}

	private renderEmptyState() {
		const open = this.insertAt === 0;
		return (
			<div class="flex flex-col items-center justify-center py-12 gap-3 relative">
				<p class="text-muted text-sm">El contenido está vacío</p>
				<button
					type="button"
					aria-label="Agregar primer bloque"
					class="w-14 h-14 rounded-full border border-surface-alt bg-surface text-2xl flex items-center justify-center hover:bg-surface-alt transition-colors shadow-sm"
					onClick={() => (this.insertAt = open ? null : 0)}
				>
					+
				</button>
				{open && <div class="absolute top-full mt-2 z-10">{this.renderTypeMenu(0)}</div>}
			</div>
		);
	}

	render() {
		return (
			<div class="flex flex-col gap-2">
				<div class="flex items-center justify-between">
					<span class="font-medium">Contenido</span>
					<button
						type="button"
						class="text-muted text-xs underline underline-offset-2 hover:no-underline"
						onClick={() => (this.showJson = !this.showJson)}
					>
						{this.showJson ? "Ocultar JSON" : "Editar JSON"}
					</button>
				</div>

				<div class="rounded-xxl border border-surface-alt p-4 flex flex-col">
					{this.blocks.length === 0 ? (
						this.renderEmptyState()
					) : (
						<div>
							{this.renderInsertSlot(0)}
							{this.blocks.map((block, index) => this.renderBlockRow(block, index))}
						</div>
					)}
				</div>

				{this.showJson && (
					<div class="flex flex-col gap-2">
						<textarea
							rows={10}
							class="w-full p-2 rounded-xxl border border-surface-alt bg-surface font-mono text-xs"
							placeholder='[{ "type": "heading", "level": 2, "text": "Título" }]'
							onInput={(ev: globalThis.Event) => (this.jsonDraft = (ev.target as HTMLTextAreaElement).value)}
						>
							{this.jsonDraft}
						</textarea>
						<div class="flex items-center gap-2">
							<button
								type="button"
								class="px-3 py-1 rounded-xxl border border-surface-alt bg-surface text-sm hover:opacity-80"
								onClick={() => this.applyJsonDraft()}
							>
								Aplicar JSON
							</button>
							{this.parseError && <span class="text-danger text-xs">JSON inválido: {this.parseError}</span>}
						</div>
					</div>
				)}
			</div>
		);
	}
}
