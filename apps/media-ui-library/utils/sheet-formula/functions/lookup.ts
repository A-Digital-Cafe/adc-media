/**
 * Strategies de búsqueda: el `JOIN` de la planilla. `VLOOKUP`/`XLOOKUP` traen
 * un dato de otra tabla por clave; `INDEX`+`MATCH` es la versión desarmada de
 * lo mismo y aguanta que la clave no esté en la primera columna.
 */

import { fail, isError, type FormulaFunction, type Scalar } from "../types.js";
import { looseEquals, compareValues } from "../values.js";
import { intArg, matrixOf, scalarOf } from "./helpers.js";

/** Fila de una búsqueda por clave, o `-1`. Con `sorted` hace búsqueda aproximada. */
function findRow(values: Scalar[][], key: Scalar, column: number, sorted: boolean): number {
	if (!sorted) return values.findIndex((row) => looseEquals(row[column], key));
	// Aproximada: la última fila cuyo valor no supera la clave (exige orden ascendente).
	let found = -1;
	for (const [index, row] of values.entries()) {
		if (compareValues(row[column], key) <= 0) found = index;
		else break;
	}
	return found;
}

/** `VLOOKUP` (por columnas) y `HLOOKUP` (por filas, con la matriz transpuesta). */
function lookup(name: string, help: string, byRow: boolean): FormulaFunction {
	return {
		name,
		minArgs: 3,
		maxArgs: 4,
		help,
		call: (args) => {
			const key = scalarOf(args[0]);
			const table = byRow ? matrixOf(args[1]) : transpose(matrixOf(args[1]));
			const index = intArg(args[2], 1);
			if (isError(index)) return index;
			// El 4º argumento es "búsqueda aproximada"; por defecto exacta, que es lo que
			// quiere el 99% de los usos (y lo que evita el resultado silenciosamente errado).
			const sorted = args.length > 3 && scalarOf(args[3]) !== false && scalarOf(args[3]) !== 0;
			const row = findRow(table, key, 0, sorted);
			if (row === -1) return fail("#N/A");
			// `undefined` es "fuera de la tabla"; `null` es una celda vacía y sí es un resultado válido.
			const cell = table[row][index - 1];
			if (cell === undefined) return fail("#REF!");
			return cell;
		},
	};
}

function transpose(values: Scalar[][]): Scalar[][] {
	const rows = values.length;
	const cols = values[0]?.length ?? 0;
	return Array.from({ length: cols }, (_, c) => Array.from({ length: rows }, (_, r) => values[r][c]));
}

/** Dimensión de un argumento (`ROWS`/`COLUMNS`). */
function dimension(name: string, help: string, pick: (values: Scalar[][]) => number): FormulaFunction {
	return { name, minArgs: 1, maxArgs: 1, help, call: (args) => pick(matrixOf(args[0])) };
}

/** `ROW`/`COLUMN`: la coordenada del argumento, o la de la propia celda si no hay. */
function coordinate(name: string, help: string, pick: (position: { r: number; c: number }) => number): FormulaFunction {
	return {
		name,
		minArgs: 0,
		maxArgs: 1,
		help,
		call: (args, ctx) => {
			const arg = args[0];
			if (!arg) return pick(ctx.self) + 1;
			if (arg.kind !== "range") return fail("#VALUE!");
			return pick({ r: arg.top, c: arg.left }) + 1;
		},
	};
}

export const LOOKUP_FUNCTIONS: readonly FormulaFunction[] = [
	lookup("VLOOKUP", "VLOOKUP(clave; tabla; columna; [aproximada]) — busca la clave en la 1ª columna", true),
	lookup("HLOOKUP", "HLOOKUP(clave; tabla; fila; [aproximada]) — busca la clave en la 1ª fila", false),
	{
		name: "XLOOKUP",
		minArgs: 3,
		maxArgs: 4,
		help: "XLOOKUP(clave; rango de claves; rango de resultados; [si no está])",
		call: (args) => {
			const key = scalarOf(args[0]);
			const keys = matrixOf(args[1]).flat();
			const results = matrixOf(args[2]).flat();
			if (keys.length !== results.length) return fail("#VALUE!");
			const index = keys.findIndex((candidate) => looseEquals(candidate, key));
			if (index !== -1) return results[index];
			return args.length > 3 ? scalarOf(args[3]) : fail("#N/A");
		},
	},
	{
		name: "MATCH",
		minArgs: 2,
		maxArgs: 3,
		help: "MATCH(clave; rango; [0 = exacta]) — posición de la clave dentro del rango",
		call: (args) => {
			const key = scalarOf(args[0]);
			const values = matrixOf(args[1]).flat();
			const mode = args.length > 2 ? intArg(args[2]) : 0;
			if (isError(mode)) return mode;
			if (mode === 0) {
				const index = values.findIndex((candidate) => looseEquals(candidate, key));
				return index === -1 ? fail("#N/A") : index + 1;
			}
			// Modo aproximado: última posición que no supera la clave (rango ordenado).
			const index = findRow(values.map((value) => [value]), key, 0, true);
			return index === -1 ? fail("#N/A") : index + 1;
		},
	},
	{
		name: "INDEX",
		minArgs: 2,
		maxArgs: 3,
		help: "INDEX(rango; fila; [columna]) — el valor en esa posición del rango",
		call: (args) => {
			const values = matrixOf(args[0]);
			const row = intArg(args[1], 0);
			if (isError(row)) return row;
			const column = args.length > 2 ? intArg(args[2], 0) : 1;
			if (isError(column)) return column;
			// Un 0 significa "la fila/columna entera": con vectores de una sola línea es
			// equivalente a pedir la primera, que es como se usa en la práctica.
			const target = values[Math.max(row, 1) - 1];
			const cell = target?.[Math.max(column, 1) - 1];
			if (cell === undefined) return fail("#REF!");
			return cell;
		},
	},
	dimension("ROWS", "ROWS(rango) — cantidad de filas", (values) => values.length),
	dimension("COLUMNS", "COLUMNS(rango) — cantidad de columnas", (values) => values[0]?.length ?? 0),
	coordinate("ROW", "ROW([celda]) — número de fila", (position) => position.r),
	coordinate("COLUMN", "COLUMN([celda]) — número de columna", (position) => position.c),
];
