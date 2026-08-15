/**
 * Coerciones entre el texto crudo de la celda y los valores del motor.
 *
 * Convención de número: punto decimal, igual que el export a FODS
 * (`NUMBER_RE` de `adcsheet.ts`). Un `1.234,56` es texto, no número — adivinar
 * el separador por celda haría que la misma columna sume distinto según la fila.
 */

import { fail, isError, type Scalar } from "./types.js";

const NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

/** Texto crudo de la celda → valor tipado (vacío, booleano, número o texto). */
export function coerceText(raw: string): Scalar {
	const text = raw.trim();
	if (text === "") return null;
	const upper = text.toUpperCase();
	if (upper === "TRUE") return true;
	if (upper === "FALSE") return false;
	if (text.endsWith("%")) {
		const body = text.slice(0, -1).trim();
		if (NUMBER_RE.test(body)) return Number(body) / 100;
	}
	return NUMBER_RE.test(text) ? Number(text) : raw;
}

/** Número de un valor, o `#VALUE!`. Vacío cuenta como 0 (como toda hoja de cálculo). */
export function toNumber(value: Scalar): number | ReturnType<typeof fail> {
	if (isError(value)) return value;
	if (value === null) return 0;
	if (typeof value === "number") return Number.isFinite(value) ? value : fail("#NUM!");
	if (typeof value === "boolean") return value ? 1 : 0;
	const parsed = coerceText(value);
	return typeof parsed === "number" ? parsed : fail("#VALUE!");
}

/** Texto de un valor para concatenar/mostrar (el error viaja como su código). */
export function toText(value: Scalar): string {
	if (isError(value)) return value.err;
	if (value === null) return "";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	return typeof value === "number" ? formatNumber(value) : value;
}

export function toBool(value: Scalar): boolean {
	if (value === null || isError(value)) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	return value.trim().toUpperCase() === "TRUE";
}

/**
 * Número → texto sin la basura del punto flotante (`0.1+0.2` se muestra `0.3`)
 * y sin notación científica salvo que el número la necesite de verdad.
 */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return "#NUM!";
	if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
	const rounded = Number.parseFloat(value.toPrecision(12));
	return String(rounded);
}

/** Valor listo para pintar en la celda. */
export function formatValue(value: Scalar): string {
	return toText(value);
}

/**
 * Orden total entre valores, con el criterio de SQL/hoja de cálculo: los
 * números van antes que el texto y los vacíos al final. Devuelve <0, 0 o >0.
 */
export function compareValues(a: Scalar, b: Scalar): number {
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	const na = typeof a === "number" ? a : null;
	const nb = typeof b === "number" ? b : null;
	if (na !== null && nb !== null) return na - nb;
	if (na !== null) return -1;
	if (nb !== null) return 1;
	return toText(a).localeCompare(toText(b), "es", { numeric: true, sensitivity: "base" });
}

/** Igualdad laxa (texto sin distinguir mayúsculas), la que usan los criterios y `MATCH`. */
export function looseEquals(a: Scalar, b: Scalar): boolean {
	if (typeof a === "number" || typeof b === "number") {
		const na = toNumber(a);
		const nb = toNumber(b);
		if (typeof na === "number" && typeof nb === "number") return na === nb;
	}
	return toText(a).trim().toLowerCase() === toText(b).trim().toLowerCase();
}
