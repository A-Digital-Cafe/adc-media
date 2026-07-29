/**
 * Parser/serializer CSV mínimo (RFC 4180): comillas, delimitadores embebidos,
 * saltos de línea dentro de celdas y comillas escapadas (`""`). Sin dependencias.
 */

export type CsvDelimiter = "," | ";" | "\t";

export interface CsvData {
	rows: string[][];
	delimiter: CsvDelimiter;
}

/** Autodetección simple: el delimitador candidato más frecuente fuera de comillas en la primera línea. */
function detectDelimiter(text: string): CsvDelimiter {
	const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
	const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
	let inQuotes = false;
	for (const ch of firstLine) {
		if (ch === '"') inQuotes = !inQuotes;
		else if (!inQuotes && (ch === "," || ch === ";" || ch === "\t")) counts[ch]++;
	}
	let best: CsvDelimiter = ",";
	for (const d of [";", "\t"] as CsvDelimiter[]) {
		if (counts[d] > counts[best]) best = d;
	}
	return best;
}

/** Parsea CSV crudo a filas. Tolerante: nunca lanza; una celda malformada queda literal. */
export function parseCsv(text: string, delimiter?: CsvDelimiter): CsvData {
	const delim = delimiter ?? detectDelimiter(text);
	const normalized = text.replaceAll("\r\n", "\n").replace(/\n$/, "");
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let inQuotes = false;

	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (inQuotes) {
			if (ch === '"') {
				if (normalized[i + 1] === '"') {
					cell += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cell += ch;
			}
			continue;
		}
		if (ch === '"' && cell === "") {
			inQuotes = true;
		} else if (ch === delim) {
			row.push(cell);
			cell = "";
		} else if (ch === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else {
			cell += ch;
		}
	}
	row.push(cell);
	rows.push(row);
	return { rows, delimiter: delim };
}

function serializeCell(value: string, delimiter: CsvDelimiter): string {
	if (value.includes('"') || value.includes(delimiter) || value.includes("\n")) {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return value;
}

/** Serializa filas a CSV (con salto de línea final). */
export function serializeCsv(rows: string[][], delimiter: CsvDelimiter = ","): string {
	return rows.map((row) => row.map((cell) => serializeCell(cell, delimiter)).join(delimiter)).join("\n") + "\n";
}
