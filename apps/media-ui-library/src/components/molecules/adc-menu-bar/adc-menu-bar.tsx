import { Component, Event, Prop, State, type EventEmitter } from "@stencil/core";

/** Item de menú de `adc-context-menu` (tipado local: la lib principal es cross-lib). */
export interface MenuBarItem {
	label: string;
	action?: string;
	danger?: boolean;
	children?: MenuBarItem[];
}

/**
 * Menú de la barra. `items` puede ser una función: se resuelve recién al
 * abrir, así los rótulos dinámicos (✓ del delimitador, "Deshacer (Ctrl+Z)")
 * no dependen de re-renders del host.
 */
export interface MenuBarMenu {
	label: string;
	items: MenuBarItem[] | (() => MenuBarItem[]);
}

/**
 * Barra de menús compartida de los editores (Archivo / Editar / Insertar):
 * los mismos botones y el mismo menú flotante en el editor de documentos y en
 * el de hojas de cálculo. El host resuelve las acciones (`adcMenuBarSelect`).
 *
 * El host element es `display: contents`: los botones participan del flex del
 * toolbar del editor (`.adc-editor-toolbar`, definido acá mismo), que puede
 * sumar botones propios alrededor con `.adc-menu-bar__btn`.
 */
@Component({
	tag: "adc-menu-bar",
	styleUrl: "adc-menu-bar.css",
	shadow: false,
})
export class AdcMenuBar {
	/** Menús a mostrar, en orden. */
	@Prop() menus: MenuBarMenu[] = [];

	@State() menu: { items: MenuBarItem[]; x: number; y: number } | null = null;

	/** Acción (`grupo:valor`) elegida en cualquiera de los menús. */
	@Event() adcMenuBarSelect!: EventEmitter<{ action: string }>;

	/** Abre un menú anclado debajo del botón que lo dispara. */
	private openMenu(ev: MouseEvent, menu: MenuBarMenu): void {
		const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
		const items = typeof menu.items === "function" ? menu.items() : menu.items;
		this.menu = { items, x: rect.left, y: rect.bottom + 4 };
	}

	render() {
		return [
			...this.menus.map((menu) => (
				<button key={menu.label} type="button" class="adc-menu-bar__btn" onClick={(ev: MouseEvent) => this.openMenu(ev, menu)}>
					{menu.label} ▾
				</button>
			)),
			<adc-context-menu
				open={this.menu !== null}
				x={this.menu?.x ?? 0}
				y={this.menu?.y ?? 0}
				items={this.menu?.items ?? []}
				onAdcContextMenuClose={() => (this.menu = null)}
				onAdcContextMenuSelect={(ev: CustomEvent<{ action: string }>) => {
					this.menu = null;
					this.adcMenuBarSelect.emit({ action: ev.detail.action });
				}}
			></adc-context-menu>,
		];
	}
}
