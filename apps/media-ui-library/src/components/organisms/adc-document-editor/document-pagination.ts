/**
 * Paginación visual del documento: reparte los bloques del flujo en hojas
 * midiendo el DOM.
 *
 * No hay motor de layout: se recorre el flujo en orden y, cuando un bloque no
 * entra en la hoja actual (o hay un salto de página explícito), se lo empuja al
 * principio de la siguiente con un margen. Un bloque más alto que una hoja
 * (una tabla enorme, una imagen) desborda su hoja — igual que en el navegador
 * al imprimir.
 */

import type { PageSetup, PageSizeId } from "@common/types/adc-document/index.js";

/** Hojas soportadas, en cm (ancho × alto) — las mismas que entiende `@page size`. */
export const PAGE_SIZES: Record<PageSizeId, { label: string; width: number; height: number; css: string }> = {
	a4: { label: "A4 (21 × 29.7 cm)", width: 21, height: 29.7, css: "A4" },
	letter: { label: "Carta (21.6 × 27.9 cm)", width: 21.6, height: 27.9, css: "Letter" },
	legal: { label: "Oficio (21.6 × 35.6 cm)", width: 21.6, height: 35.6, css: "Legal" },
};

/** Configuración por defecto: A4 con márgenes de 2cm. */
export const DEFAULT_PAGE_SETUP: PageSetup = { size: "a4", margins: { top: 2, right: 2, bottom: 2, left: 2 } };

/** Configuración efectiva de un documento (rellena lo que falte con la de por defecto). */
export function pageSetupOf(setup?: PageSetup): PageSetup {
	if (!setup) return DEFAULT_PAGE_SETUP;
	return {
		size: PAGE_SIZES[setup.size] ? setup.size : DEFAULT_PAGE_SETUP.size,
		margins: { ...DEFAULT_PAGE_SETUP.margins, ...setup.margins },
	};
}

/** Proporción alto/ancho de la hoja (el ancho lo define el contenedor). */
export function pageRatio(setup: PageSetup): number {
	const size = PAGE_SIZES[setup.size] ?? PAGE_SIZES.a4;
	return size.height / size.width;
}

/** Márgenes como fracción del alto/ancho de la hoja (para traducirlos a px). */
export function marginRatios(setup: PageSetup): { top: number; bottom: number; left: number; right: number } {
	const size = PAGE_SIZES[setup.size] ?? PAGE_SIZES.a4;
	return {
		top: setup.margins.top / size.height,
		bottom: setup.margins.bottom / size.height,
		left: setup.margins.left / size.width,
		right: setup.margins.right / size.width,
	};
}

/** Separación visual entre hojas, en px. */
export const PAGE_GAP_PX = 24;

export interface Pagination {
	/** Offset (px, relativo al contenedor de hojas) donde arranca cada página. */
	starts: number[];
	/** Alto de una hoja en px (0 = vista continua, sin hojas). */
	pageHeight: number;
}

/** Selector de los saltos de página embebidos en el flujo del editor. */
const PAGE_BREAK_SELECTOR = ".adc-blocks-editor__standalone--break";

/** Distancia vertical de `el` al tope de `container` (independiente del offsetParent). */
export function offsetWithin(el: HTMLElement, container: HTMLElement): number {
	return el.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

/**
 * Mide `root` (el contenteditable) dentro de `container` y reparte sus bloques
 * en hojas de `pageHeight` px. Con `pageHeight <= 0` deshace la paginación
 * (vista continua) y devuelve una sola página.
 */
export function paginateFlow(root: HTMLElement, container: HTMLElement, pageHeight: number, setup: PageSetup): Pagination {
	const children = Array.from(root.children) as HTMLElement[];
	for (const el of children) el.style.marginTop = "";
	if (pageHeight <= 0 || children.length === 0) return { starts: [0], pageHeight: 0 };

	const ratios = marginRatios(setup);
	const margin = pageHeight * ratios.top;
	// El texto vive entre los márgenes superior e inferior de la hoja.
	const usable = pageHeight * (1 - ratios.top - ratios.bottom);
	if (usable <= 0) return { starts: [0], pageHeight };

	// La primera hoja arranca justo encima del primer bloque: lo que haya antes
	// (la barra de formato del editor) queda fuera del papel.
	const base = Math.max(0, offsetWithin(children[0], container) - margin);
	const starts = [base];
	let pageBottom = base + margin + usable;
	// Un salto de página explícito no se mueve: empuja al bloque siguiente.
	let forceBreak = false;
	for (const el of children) {
		const top = offsetWithin(el, container);
		const isBreak = el.matches(PAGE_BREAK_SELECTOR) || !!el.querySelector(PAGE_BREAK_SELECTOR);
		if (top > base && (forceBreak || top + el.offsetHeight > pageBottom)) {
			const lastStart = starts[starts.length - 1];
			const nextStart = lastStart + pageHeight + PAGE_GAP_PX;
			const shift = nextStart + margin - top;
			if (shift > 0) el.style.marginTop = `${Math.round(shift)}px`;
			starts.push(nextStart);
			pageBottom = nextStart + margin + usable;
		}
		forceBreak = isBreak;
	}
	return { starts, pageHeight };
}
