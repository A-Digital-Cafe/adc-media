/** Strategies de texto: limpieza, recorte y armado de cadenas. */

import { fail, isError, type FormulaFunction, type Scalar } from "../types.js";
import { coerceText, toText } from "../values.js";
import { flatten, intArg, matrixOf, numberArg, scalarOf } from "./helpers.js";

/** Envuelve una transformación de texto a texto. */
function unaryText(name: string, help: string, apply: (text: string) => Scalar): FormulaFunction {
	return {
		name,
		minArgs: 1,
		maxArgs: 1,
		help,
		call: (args) => apply(toText(scalarOf(args[0]))),
	};
}

/** `LEFT`/`RIGHT`: n caracteres desde un extremo (1 por defecto). */
function edge(name: string, help: string, fromStart: boolean): FormulaFunction {
	return {
		name,
		minArgs: 1,
		maxArgs: 2,
		help,
		call: (args) => {
			const text = toText(scalarOf(args[0]));
			const count = args.length > 1 ? intArg(args[1], 0) : 1;
			if (isError(count)) return count;
			return fromStart ? text.slice(0, count) : text.slice(text.length - count);
		},
	};
}

/** `FIND` (sensible a mayúsculas) y `SEARCH` (insensible). */
function finder(name: string, help: string, caseSensitive: boolean): FormulaFunction {
	return {
		name,
		minArgs: 2,
		maxArgs: 3,
		help,
		call: (args) => {
			const needle = toText(scalarOf(args[0]));
			const haystack = toText(scalarOf(args[1]));
			const from = args.length > 2 ? intArg(args[2], 1) : 1;
			if (isError(from)) return from;
			const index = caseSensitive
				? haystack.indexOf(needle, from - 1)
				: haystack.toLowerCase().indexOf(needle.toLowerCase(), from - 1);
			return index === -1 ? fail("#VALUE!") : index + 1;
		},
	};
}

export const TEXT_FUNCTIONS: readonly FormulaFunction[] = [
	unaryText("UPPER", "UPPER(texto) — todo en mayúsculas", (text) => text.toUpperCase()),
	unaryText("LOWER", "LOWER(texto) — todo en minúsculas", (text) => text.toLowerCase()),
	unaryText("TRIM", "TRIM(texto) — saca los espacios de sobra", (text) => text.trim().replaceAll(/\s+/g, " ")),
	unaryText("LEN", "LEN(texto) — cantidad de caracteres", (text) => [...text].length),
	unaryText("PROPER", "PROPER(texto) — Primera Letra De Cada Palabra En Mayúscula", (text) =>
		text.toLowerCase().replaceAll(/(^|\s|['-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase())
	),
	unaryText("VALUE", "VALUE(texto) — convierte el texto en número", (text) => {
		const parsed = coerceText(text);
		return typeof parsed === "number" ? parsed : fail("#VALUE!");
	}),
	edge("LEFT", "LEFT(texto; [n]) — los primeros n caracteres", true),
	edge("RIGHT", "RIGHT(texto; [n]) — los últimos n caracteres", false),
	finder("FIND", "FIND(buscado; texto; [desde]) — posición, distingue mayúsculas", true),
	finder("SEARCH", "SEARCH(buscado; texto; [desde]) — posición, sin distinguir mayúsculas", false),
	{
		name: "MID",
		minArgs: 3,
		maxArgs: 3,
		help: "MID(texto; desde; cantidad) — trozo del texto (desde es 1-based)",
		call: (args) => {
			const text = toText(scalarOf(args[0]));
			const start = intArg(args[1], 1);
			if (isError(start)) return start;
			const count = intArg(args[2], 0);
			if (isError(count)) return count;
			return text.slice(start - 1, start - 1 + count);
		},
	},
	{
		name: "CONCAT",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "CONCAT(valores…) — pega todo (alias: CONCATENATE)",
		call: (args) => flatten(args).map(toText).join(""),
	},
	{
		name: "TEXTJOIN",
		minArgs: 3,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "TEXTJOIN(separador; ignorar vacías; valores…) — pega con separador",
		call: (args) => {
			const separator = toText(scalarOf(args[0]));
			const skipEmpty = scalarOf(args[1]) !== false;
			const values = flatten(args.slice(2));
			const parts = skipEmpty ? values.filter((value) => value !== null && value !== "") : values;
			return parts.map(toText).join(separator);
		},
	},
	{
		name: "SUBSTITUTE",
		minArgs: 3,
		maxArgs: 3,
		help: "SUBSTITUTE(texto; buscado; reemplazo) — reemplaza todas las apariciones",
		call: (args) => {
			const text = toText(scalarOf(args[0]));
			const needle = toText(scalarOf(args[1]));
			const replacement = toText(scalarOf(args[2]));
			return needle === "" ? text : text.replaceAll(needle, replacement);
		},
	},
	{
		name: "REPLACE",
		minArgs: 4,
		maxArgs: 4,
		help: "REPLACE(texto; desde; cantidad; reemplazo) — reemplaza por posición",
		call: (args) => {
			const text = toText(scalarOf(args[0]));
			const start = intArg(args[1], 1);
			if (isError(start)) return start;
			const count = intArg(args[2], 0);
			if (isError(count)) return count;
			return text.slice(0, start - 1) + toText(scalarOf(args[3])) + text.slice(start - 1 + count);
		},
	},
	{
		name: "REPT",
		minArgs: 2,
		maxArgs: 2,
		help: "REPT(texto; veces) — repite el texto",
		call: (args) => {
			const text = toText(scalarOf(args[0]));
			const times = intArg(args[1], 0);
			if (isError(times)) return times;
			// Tope duro: un REPT sin techo llena la memoria de la pestaña.
			if (text.length * times > 10_000) return fail("#LIMIT!");
			return text.repeat(times);
		},
	},
	{
		name: "EXACT",
		minArgs: 2,
		maxArgs: 2,
		help: "EXACT(a; b) — TRUE si son idénticos (distingue mayúsculas)",
		call: (args) => toText(scalarOf(args[0])) === toText(scalarOf(args[1])),
	},
	{
		name: "SPLIT",
		minArgs: 1,
		maxArgs: 2,
		help: "SPLIT(texto; [separador]) — parte el texto en columnas (por defecto la coma)",
		spills: true,
		call: (args, ctx) => {
			const text = toText(scalarOf(args[0]));
			const separator = args.length > 1 ? toText(scalarOf(args[1])) : ",";
			const parts = separator === "" ? [...text] : text.split(separator);
			if (parts.length > ctx.limits.maxSpillCols) return fail("#LIMIT!");
			return [parts.map((part): Scalar => coerceText(part))];
		},
	},
	{
		name: "TEXT",
		minArgs: 1,
		maxArgs: 2,
		help: "TEXT(número; [decimales]) — número como texto con decimales fijos",
		call: (args) => {
			const value = numberArg(args[0]);
			if (isError(value)) return value;
			const digits = args.length > 1 ? intArg(args[1], 0) : 2;
			if (isError(digits)) return digits;
			return value.toFixed(Math.min(digits, 20));
		},
	},
	{
		name: "JOINROWS",
		minArgs: 1,
		maxArgs: 2,
		help: "JOINROWS(rango; [separador]) — una línea de texto por fila del rango",
		spills: true,
		call: (args) => {
			const separator = args.length > 1 ? toText(scalarOf(args[1])) : " ";
			return matrixOf(args[0]).map((row): Scalar[] => [row.map(toText).join(separator)]);
		},
	},
];

/** Alias de nombre → función canónica. */
export const TEXT_ALIASES: Readonly<Record<string, string>> = { CONCATENATE: "CONCAT" };
