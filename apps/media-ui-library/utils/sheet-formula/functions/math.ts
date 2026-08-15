/** Strategies matemáticas. */

import { fail, isError, type FormulaError, type FormulaFunction, type Scalar } from "../types.js";
import { toNumber } from "../values.js";
import { collectNumbers, intArg, matrixOf, numberArg } from "./helpers.js";

/** Envuelve una función de un solo número (el patrón de casi toda esta lista). */
function unary(name: string, help: string, apply: (x: number) => number | Scalar): FormulaFunction {
	return {
		name,
		minArgs: 1,
		maxArgs: 1,
		help,
		call: (args) => {
			const x = numberArg(args[0]);
			return isError(x) ? x : apply(x);
		},
	};
}

/** Redondeo a `digits` decimales con una estrategia de corte por parámetro. */
function rounder(name: string, help: string, cut: (x: number) => number): FormulaFunction {
	return {
		name,
		minArgs: 1,
		maxArgs: 2,
		help,
		call: (args) => {
			const x = numberArg(args[0]);
			if (isError(x)) return x;
			const digits = args.length > 1 ? intArg(args[1]) : 0;
			if (isError(digits)) return digits;
			// Escalar y volver: `toFixed` no sirve para dígitos negativos (decenas, centenas).
			const factor = 10 ** Math.min(Math.max(digits, -15), 15);
			const scaled = cut(x * factor) / factor;
			return Number.isFinite(scaled) ? scaled : fail("#NUM!");
		},
	};
}

export const MATH_FUNCTIONS: readonly FormulaFunction[] = [
	unary("ABS", "ABS(número) — valor absoluto", Math.abs),
	unary("SIGN", "SIGN(número) — -1, 0 o 1 según el signo", Math.sign),
	unary("SQRT", "SQRT(número) — raíz cuadrada", (x) => (x < 0 ? fail("#NUM!") : Math.sqrt(x))),
	unary("EXP", "EXP(número) — e elevado al número", Math.exp),
	unary("LN", "LN(número) — logaritmo natural", (x) => (x <= 0 ? fail("#NUM!") : Math.log(x))),
	unary("LOG10", "LOG10(número) — logaritmo en base 10", (x) => (x <= 0 ? fail("#NUM!") : Math.log10(x))),
	unary("INT", "INT(número) — entero inferior", Math.floor),
	unary("TRUNC", "TRUNC(número) — quita los decimales sin redondear", Math.trunc),
	rounder("ROUND", "ROUND(número; [decimales]) — redondeo al más cercano", Math.round),
	rounder("ROUNDUP", "ROUNDUP(número; [decimales]) — redondea alejándose del cero", (x) => (x < 0 ? Math.floor(x) : Math.ceil(x))),
	rounder("ROUNDDOWN", "ROUNDDOWN(número; [decimales]) — redondea hacia el cero", Math.trunc),
	rounder("CEILING", "CEILING(número; [decimales]) — redondea hacia arriba", Math.ceil),
	rounder("FLOOR", "FLOOR(número; [decimales]) — redondea hacia abajo", Math.floor),
	{
		name: "PI",
		minArgs: 0,
		maxArgs: 0,
		help: "PI() — la constante π",
		call: () => Math.PI,
	},
	{
		name: "LOG",
		minArgs: 1,
		maxArgs: 2,
		help: "LOG(número; [base]) — logaritmo en la base indicada (10 por defecto)",
		call: (args) => {
			const x = numberArg(args[0]);
			if (isError(x)) return x;
			const base = args.length > 1 ? numberArg(args[1]) : 10;
			if (isError(base)) return base;
			if (x <= 0 || base <= 0 || base === 1) return fail("#NUM!");
			return Math.log(x) / Math.log(base);
		},
	},
	{
		name: "POWER",
		minArgs: 2,
		maxArgs: 2,
		help: "POWER(base; exponente) — potencia (alias: POW)",
		call: (args) => {
			const base = numberArg(args[0]);
			if (isError(base)) return base;
			const exponent = numberArg(args[1]);
			if (isError(exponent)) return exponent;
			const result = base ** exponent;
			return Number.isFinite(result) ? result : fail("#NUM!");
		},
	},
	{
		name: "MOD",
		minArgs: 2,
		maxArgs: 2,
		help: "MOD(número; divisor) — resto de la división",
		call: (args) => {
			const value = numberArg(args[0]);
			if (isError(value)) return value;
			const divisor = numberArg(args[1]);
			if (isError(divisor)) return divisor;
			if (divisor === 0) return fail("#DIV/0!");
			// Resto con el signo del divisor (criterio de hoja de cálculo, no el de `%`).
			return value - divisor * Math.floor(value / divisor);
		},
	},
	{
		name: "PRODUCT",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "PRODUCT(valores…) — multiplica todos los números",
		call: (args) => {
			const numbers = collectNumbers(args);
			if (isError(numbers)) return numbers;
			return numbers.reduce((acc, n) => acc * n, 1);
		},
	},
	{
		name: "SUMPRODUCT",
		minArgs: 2,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "SUMPRODUCT(rango1; rango2; …) — suma de los productos celda a celda",
		call: (args) => {
			const matrices = args.map(matrixOf);
			const rows = matrices[0].length;
			const cols = matrices[0][0]?.length ?? 0;
			if (matrices.some((m) => m.length !== rows || (m[0]?.length ?? 0) !== cols)) return fail("#VALUE!");
			let total = 0;
			for (let r = 0; r < rows; r++) {
				for (let c = 0; c < cols; c++) {
					const product = cellProduct(matrices, r, c);
					if (isError(product)) return product;
					total += product;
				}
			}
			return total;
		},
	},
];

/** Producto de la misma celda en todas las matrices; el texto vale 0 (criterio de Excel). */
function cellProduct(matrices: Scalar[][][], r: number, c: number): number | FormulaError {
	let product = 1;
	for (const matrix of matrices) {
		const value = matrix[r][c];
		if (isError(value)) return value;
		const n = typeof value === "number" ? value : toNumber(value);
		product *= isError(n) ? 0 : n;
	}
	return product;
}

/** Alias de nombre → función canónica (los que la gente ya tiene en los dedos). */
export const MATH_ALIASES: Readonly<Record<string, string>> = { POW: "POWER" };
