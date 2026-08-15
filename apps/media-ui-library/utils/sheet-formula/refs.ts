/** Referencias estilo A1 ↔ coordenadas (0-based) de la grilla. */

/** Rótulo de columna estilo hoja de cálculo (A, B, …, Z, AA, AB, …). */
export function columnLetter(index: number): string {
	let label = "";
	let i = index + 1;
	while (i > 0) {
		i -= 1;
		label = String.fromCodePoint(65 + (i % 26)) + label;
		i = Math.floor(i / 26);
	}
	return label;
}

/** Índice 0-based de una columna por sus letras ("A" → 0, "AA" → 26). `-1` si no es válida. */
export function columnIndex(letters: string): number {
	if (!letters) return -1;
	let index = 0;
	for (const ch of letters.toUpperCase()) {
		const code = ch.codePointAt(0)!;
		if (code < 65 || code > 90) return -1;
		index = index * 26 + (code - 64);
	}
	return index - 1;
}

/** Referencia A1 (con o sin `$`) a coordenadas, o `null` si no lo es. */
export function parseRef(text: string): { r: number; c: number } | null {
	const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text);
	if (!match) return null;
	const c = columnIndex(match[1]);
	const r = Number(match[2]) - 1;
	return c < 0 || r < 0 ? null : { r, c };
}

/** Clave interna de una celda en los mapas de la evaluación. */
export function cellKey(r: number, c: number): string {
	return `${r}:${c}`;
}

/** Rótulo A1 de una celda (el que ve el usuario y el que viaja a la caché). */
export function refLabel(r: number, c: number): string {
	return `${columnLetter(c)}${r + 1}`;
}
