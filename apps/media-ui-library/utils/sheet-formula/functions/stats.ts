/**
 * Strategies de agregación: las mismas de `SELECT … GROUP BY` de SQL
 * (`SUM`, `AVG`, `COUNT`, `MIN`, `MAX`) más las estadísticas habituales y la
 * familia condicional `…IF`, que es el `WHERE` de la planilla.
 */

import { fail, isError, type Arg, type FormulaError, type FormulaFunction, type Scalar } from "../types.js";
import { collectNumbers, flatten, intArg, matchesCriterion, numberArg, scalarOf } from "./helpers.js";

/** Función sobre la lista de números de los argumentos (el patrón de casi toda la lista). */
function overNumbers(
	name: string,
	help: string,
	minArgs: number,
	apply: (values: number[]) => number | FormulaError
): FormulaFunction {
	return {
		name,
		minArgs,
		maxArgs: Number.POSITIVE_INFINITY,
		help,
		call: (args) => {
			const numbers = collectNumbers(args);
			return isError(numbers) ? numbers : apply(numbers);
		},
	};
}

const sum = (values: number[]): number => values.reduce((acc, n) => acc + n, 0);

const mean = (values: number[]): number | FormulaError => (values.length === 0 ? fail("#DIV/0!") : sum(values) / values.length);

/** Suma de cuadrados de las desviaciones: base común de varianza y desvío. */
function sumSquaredDeviations(values: number[]): number {
	const average = sum(values) / values.length;
	return values.reduce((acc, n) => acc + (n - average) ** 2, 0);
}

function variance(values: number[], population: boolean): number | FormulaError {
	const divisor = population ? values.length : values.length - 1;
	if (divisor <= 0) return fail("#DIV/0!");
	return sumSquaredDeviations(values) / divisor;
}

/**
 * Percentil por interpolación lineal (el método por defecto de toda hoja de
 * cálculo y el `PERCENTILE_CONT` de SQL). `fraction` va de 0 a 1.
 */
function percentile(values: number[], fraction: number): number | FormulaError {
	if (values.length === 0) return fail("#NUM!");
	if (fraction < 0 || fraction > 1) return fail("#NUM!");
	const sorted = [...values].sort((a, b) => a - b);
	const position = fraction * (sorted.length - 1);
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Pares (valor a evaluar, criterio) de las familias `…IFS`, empezando en
 * `start`. Devuelve las posiciones del rango de criterios que pasan el filtro.
 */
function matchingIndexes(args: Arg[], start: number): number[] | FormulaError {
	const pairs: Array<{ values: Scalar[]; criterion: Scalar }> = [];
	for (let i = start; i + 1 < args.length; i += 2) {
		pairs.push({ values: flatten([args[i]]), criterion: scalarOf(args[i + 1]) });
	}
	if (pairs.length === 0) return fail("#VALUE!");
	const length = pairs[0].values.length;
	if (pairs.some((pair) => pair.values.length !== length)) return fail("#VALUE!");

	const indexes: number[] = [];
	for (let i = 0; i < length; i++) {
		if (pairs.every((pair) => matchesCriterion(pair.values[i], pair.criterion))) indexes.push(i);
	}
	return indexes;
}

/** Números de `target` en las posiciones que pasaron el filtro (el texto se ignora). */
function pickNumbers(target: Scalar[], indexes: number[]): number[] | FormulaError {
	const out: number[] = [];
	for (const index of indexes) {
		const value = target[index];
		if (isError(value)) return value;
		if (typeof value === "number") out.push(value);
		else if (typeof value === "boolean") out.push(value ? 1 : 0);
	}
	return out;
}

/** `SUMIFS`/`AVERAGEIFS`: rango a agregar primero, luego los pares rango/criterio. */
function conditionalAggregate(name: string, help: string, apply: (values: number[]) => number | FormulaError): FormulaFunction {
	return {
		name,
		minArgs: 3,
		maxArgs: Number.POSITIVE_INFINITY,
		help,
		call: (args) => {
			const target = flatten([args[0]]);
			const indexes = matchingIndexes(args, 1);
			if (isError(indexes)) return indexes;
			const criteriaLength = flatten([args[1]]).length;
			if (target.length !== criteriaLength) return fail("#VALUE!");
			const numbers = pickNumbers(target, indexes);
			return isError(numbers) ? numbers : apply(numbers);
		},
	};
}

/** `LARGE`/`SMALL`: el n-ésimo valor desde un extremo del orden. */
function nth(name: string, help: string, fromEnd: boolean): FormulaFunction {
	return {
		name,
		minArgs: 2,
		maxArgs: 2,
		help,
		call: (args) => {
			const numbers = collectNumbers([args[0]]);
			if (isError(numbers)) return numbers;
			const k = intArg(args[1], 1);
			if (isError(k)) return k;
			if (k > numbers.length) return fail("#NUM!");
			const sorted = [...numbers].sort((a, b) => a - b);
			return fromEnd ? sorted[sorted.length - k] : sorted[k - 1];
		},
	};
}

export const STATS_FUNCTIONS: readonly FormulaFunction[] = [
	overNumbers("SUM", "SUM(valores…) — suma", 1, sum),
	overNumbers("AVERAGE", "AVERAGE(valores…) — promedio (alias: AVG)", 1, mean),
	overNumbers("MIN", "MIN(valores…) — mínimo", 1, (values) => (values.length === 0 ? 0 : Math.min(...values))),
	overNumbers("MAX", "MAX(valores…) — máximo", 1, (values) => (values.length === 0 ? 0 : Math.max(...values))),
	overNumbers("MEDIAN", "MEDIAN(valores…) — mediana", 1, (values) => percentile(values, 0.5)),
	overNumbers("STDEV", "STDEV(valores…) — desvío estándar de la muestra", 1, (values) => {
		const result = variance(values, false);
		return isError(result) ? result : Math.sqrt(result);
	}),
	overNumbers("STDEVP", "STDEVP(valores…) — desvío estándar de la población", 1, (values) => {
		const result = variance(values, true);
		return isError(result) ? result : Math.sqrt(result);
	}),
	overNumbers("VAR", "VAR(valores…) — varianza de la muestra", 1, (values) => variance(values, false)),
	overNumbers("VARP", "VARP(valores…) — varianza de la población", 1, (values) => variance(values, true)),
	{
		name: "COUNT",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "COUNT(valores…) — cuenta sólo los números",
		call: (args) => {
			const numbers = collectNumbers(args);
			return isError(numbers) ? numbers : numbers.length;
		},
	},
	{
		name: "COUNTA",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "COUNTA(valores…) — cuenta las celdas no vacías",
		call: (args) => flatten(args).filter((value) => value !== null && value !== "").length,
	},
	{
		name: "COUNTBLANK",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "COUNTBLANK(valores…) — cuenta las celdas vacías",
		call: (args) => flatten(args).filter((value) => value === null || value === "").length,
	},
	{
		name: "MODE",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "MODE(valores…) — el número que más se repite",
		call: (args) => {
			const numbers = collectNumbers(args);
			if (isError(numbers)) return numbers;
			const counts = new Map<number, number>();
			let best: number | null = null;
			for (const n of numbers) {
				const count = (counts.get(n) ?? 0) + 1;
				counts.set(n, count);
				if (best === null || count > counts.get(best)!) best = n;
			}
			return best ?? fail("#N/A");
		},
	},
	{
		name: "PERCENTILE",
		minArgs: 2,
		maxArgs: 2,
		help: "PERCENTILE(rango; fracción) — percentil interpolado (0 a 1)",
		call: (args) => {
			const numbers = collectNumbers([args[0]]);
			if (isError(numbers)) return numbers;
			const fraction = numberArg(args[1]);
			if (isError(fraction)) return fraction;
			// Un 90 suelto casi siempre quiere decir "percentil 90", no una fracción inválida.
			return percentile(numbers, fraction > 1 && fraction <= 100 ? fraction / 100 : fraction);
		},
	},
	{
		name: "QUARTILE",
		minArgs: 2,
		maxArgs: 2,
		help: "QUARTILE(rango; cuartil 0-4)",
		call: (args) => {
			const numbers = collectNumbers([args[0]]);
			if (isError(numbers)) return numbers;
			const quartile = intArg(args[1], 0);
			if (isError(quartile)) return quartile;
			return quartile > 4 ? fail("#NUM!") : percentile(numbers, quartile / 4);
		},
	},
	nth("LARGE", "LARGE(rango; n) — el n-ésimo valor más grande", true),
	nth("SMALL", "SMALL(rango; n) — el n-ésimo valor más chico", false),
	{
		name: "RANK",
		minArgs: 2,
		maxArgs: 3,
		help: "RANK(valor; rango; [1 = ascendente]) — posición del valor en el rango",
		call: (args) => {
			const value = numberArg(args[0]);
			if (isError(value)) return value;
			const numbers = collectNumbers([args[1]]);
			if (isError(numbers)) return numbers;
			const ascending = args.length > 2 && numberArg(args[2]) !== 0;
			const better = numbers.filter((n) => (ascending ? n < value : n > value)).length;
			return better + 1;
		},
	},
	{
		name: "COUNTIF",
		minArgs: 2,
		maxArgs: 2,
		help: 'COUNTIF(rango; criterio) — cuenta los que cumplen, ej: ">100"',
		call: (args) => {
			const criterion = scalarOf(args[1]);
			return flatten([args[0]]).filter((value) => matchesCriterion(value, criterion)).length;
		},
	},
	{
		name: "COUNTIFS",
		minArgs: 2,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "COUNTIFS(rango1; criterio1; …) — cuenta los que cumplen todos los criterios",
		call: (args) => {
			const indexes = matchingIndexes(args, 0);
			return isError(indexes) ? indexes : indexes.length;
		},
	},
	{
		name: "SUMIF",
		minArgs: 2,
		maxArgs: 3,
		help: "SUMIF(rango; criterio; [rango a sumar]) — suma los que cumplen",
		call: (args) => {
			const criterion = scalarOf(args[1]);
			const source = flatten([args[0]]);
			const target = args.length > 2 ? flatten([args[2]]) : source;
			if (target.length !== source.length) return fail("#VALUE!");
			const indexes = source.flatMap((value, i) => (matchesCriterion(value, criterion) ? [i] : []));
			const numbers = pickNumbers(target, indexes);
			return isError(numbers) ? numbers : sum(numbers);
		},
	},
	conditionalAggregate("SUMIFS", "SUMIFS(rango a sumar; rango1; criterio1; …) — suma con varios criterios", sum),
	conditionalAggregate("AVERAGEIFS", "AVERAGEIFS(rango; rango1; criterio1; …) — promedio con varios criterios", mean),
	{
		name: "AVERAGEIF",
		minArgs: 2,
		maxArgs: 3,
		help: "AVERAGEIF(rango; criterio; [rango a promediar]) — promedio de los que cumplen",
		call: (args) => {
			const criterion = scalarOf(args[1]);
			const source = flatten([args[0]]);
			const target = args.length > 2 ? flatten([args[2]]) : source;
			if (target.length !== source.length) return fail("#VALUE!");
			const indexes = source.flatMap((value, i) => (matchesCriterion(value, criterion) ? [i] : []));
			const numbers = pickNumbers(target, indexes);
			return isError(numbers) ? numbers : mean(numbers);
		},
	},
	{
		name: "SUBTOTAL",
		minArgs: 2,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "SUBTOTAL(función 1-4; valores…) — 1 promedio, 2 contar, 3 contar no vacías, 4 sumar",
		call: (args) => {
			const which = intArg(args[0], 1);
			if (isError(which)) return which;
			const rest = args.slice(1);
			if (which === 3) return flatten(rest).filter((value) => value !== null && value !== "").length;
			const numbers = collectNumbers(rest);
			if (isError(numbers)) return numbers;
			if (which === 1) return mean(numbers);
			if (which === 2) return numbers.length;
			return which === 4 ? sum(numbers) : fail("#VALUE!");
		},
	},
	{
		name: "MINIFS",
		minArgs: 3,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "MINIFS(rango; rango1; criterio1; …) — mínimo de los que cumplen",
		call: minMaxIfs(true),
	},
	{
		name: "MAXIFS",
		minArgs: 3,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "MAXIFS(rango; rango1; criterio1; …) — máximo de los que cumplen",
		call: minMaxIfs(false),
	},
];

function minMaxIfs(wantMin: boolean): FormulaFunction["call"] {
	return (args) => {
		const target = flatten([args[0]]);
		const indexes = matchingIndexes(args, 1);
		if (isError(indexes)) return indexes;
		const numbers = pickNumbers(target, indexes);
		if (isError(numbers)) return numbers;
		if (numbers.length === 0) return 0;
		return wantMin ? Math.min(...numbers) : Math.max(...numbers);
	};
}

/** Alias que la gente escribe por costumbre de SQL o de otras planillas. */
export const STATS_ALIASES: Readonly<Record<string, string>> = { AVG: "AVERAGE" };
