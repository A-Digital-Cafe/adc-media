/**
 * Strategies lógicas y de control de nulos. Incluye `COALESCE` y `NULLIF`, que
 * son los de SQL y hacen lo mismo acá: primer valor no vacío y "vaciá esto si
 * coincide" — un `IF(A1="";…)` anidado menos por planilla.
 *
 * Los argumentos llegan ya evaluados: los errores son valores, así que
 * `IFERROR` puede mirarlos sin necesidad de evaluación perezosa.
 */

import { fail, isError, type FormulaFunction, type Scalar } from "../types.js";
import { looseEquals, toBool } from "../values.js";
import { flatten, scalarOf } from "./helpers.js";

/** Predicado sobre el primer argumento (la familia `IS…`). */
function predicate(name: string, help: string, test: (value: Scalar) => boolean): FormulaFunction {
	return { name, minArgs: 1, maxArgs: 1, help, acceptsErrors: true, call: (args) => test(scalarOf(args[0])) };
}

/** `AND`/`OR`: reduce todos los valores de todos los argumentos. */
function chain(name: string, help: string, mode: "and" | "or"): FormulaFunction {
	return {
		name,
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		help,
		call: (args) => {
			const values = flatten(args).filter((value) => value !== null);
			if (values.length === 0) return fail("#VALUE!");
			const error = values.find(isError);
			if (error) return error;
			return mode === "and" ? values.every(toBool) : values.some(toBool);
		},
	};
}

export const LOGIC_FUNCTIONS: readonly FormulaFunction[] = [
	{
		name: "IF",
		minArgs: 2,
		maxArgs: 3,
		help: "IF(condición; valor si sí; [valor si no])",
		acceptsErrors: true,
		call: (args) => {
			const condition = scalarOf(args[0]);
			// Una condición rota sí corta: el resultado sería una rama elegida al azar.
			if (isError(condition)) return condition;
			if (toBool(condition)) return scalarOf(args[1]);
			return args.length > 2 ? scalarOf(args[2]) : false;
		},
	},
	{
		name: "IFS",
		minArgs: 2,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "IFS(condición1; valor1; condición2; valor2; …) — la primera que se cumple",
		acceptsErrors: true,
		call: (args) => {
			for (let i = 0; i + 1 < args.length; i += 2) {
				const condition = scalarOf(args[i]);
				if (isError(condition)) return condition;
				if (toBool(condition)) return scalarOf(args[i + 1]);
			}
			return fail("#N/A");
		},
	},
	{
		name: "SWITCH",
		minArgs: 3,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "SWITCH(valor; caso1; resultado1; …; [por defecto])",
		acceptsErrors: true,
		call: (args) => {
			const subject = scalarOf(args[0]);
			if (isError(subject)) return subject;
			let i = 1;
			for (; i + 1 < args.length; i += 2) {
				if (looseEquals(subject, scalarOf(args[i]))) return scalarOf(args[i + 1]);
			}
			// Sobró un argumento suelto: es el valor por defecto.
			return i < args.length ? scalarOf(args[i]) : fail("#N/A");
		},
	},
	chain("AND", "AND(condiciones…) — TRUE si se cumplen todas", "and"),
	chain("OR", "OR(condiciones…) — TRUE si se cumple alguna", "or"),
	{
		name: "NOT",
		minArgs: 1,
		maxArgs: 1,
		help: "NOT(condición) — invierte el valor lógico",
		call: (args) => !toBool(scalarOf(args[0])),
	},
	{
		name: "XOR",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "XOR(condiciones…) — TRUE si se cumple una cantidad impar",
		call: (args) => flatten(args).filter(toBool).length % 2 === 1,
	},
	{
		name: "IFERROR",
		minArgs: 2,
		maxArgs: 2,
		help: "IFERROR(valor; alternativa) — la alternativa si el valor da error",
		acceptsErrors: true,
		call: (args) => {
			const value = scalarOf(args[0]);
			return isError(value) ? scalarOf(args[1]) : value;
		},
	},
	{
		name: "IFNA",
		minArgs: 2,
		maxArgs: 2,
		help: "IFNA(valor; alternativa) — la alternativa sólo si el valor da #N/A",
		acceptsErrors: true,
		call: (args) => {
			const value = scalarOf(args[0]);
			return isError(value) && value.err === "#N/A" ? scalarOf(args[1]) : value;
		},
	},
	{
		name: "COALESCE",
		minArgs: 1,
		maxArgs: Number.POSITIVE_INFINITY,
		help: "COALESCE(valores…) — el primero que no esté vacío (como en SQL)",
		acceptsErrors: true,
		call: (args) => flatten(args).find((value) => value !== null && value !== "" && !isError(value)) ?? null,
	},
	{
		name: "NULLIF",
		minArgs: 2,
		maxArgs: 2,
		help: "NULLIF(valor; comparado) — vacío si son iguales, el valor si no (como en SQL)",
		acceptsErrors: true,
		call: (args) => {
			const value = scalarOf(args[0]);
			return looseEquals(value, scalarOf(args[1])) ? null : value;
		},
	},
	predicate("ISERROR", "ISERROR(valor) — TRUE si el valor es un error", isError),
	predicate("ISBLANK", "ISBLANK(valor) — TRUE si la celda está vacía", (value) => value === null || value === ""),
	predicate("ISNUMBER", "ISNUMBER(valor) — TRUE si es un número", (value) => typeof value === "number"),
	predicate("ISTEXT", "ISTEXT(valor) — TRUE si es texto", (value) => typeof value === "string" && value !== ""),
	predicate("ISLOGICAL", "ISLOGICAL(valor) — TRUE si es TRUE o FALSE", (value) => typeof value === "boolean"),
];
