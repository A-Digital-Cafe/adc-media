/**
 * Strategies de fecha. Las fechas son **texto ISO** (`2026-08-14`), no el
 * número de serie de Excel: la hoja se guarda como texto plano y un `.csv`
 * abierto en cualquier otro lado tiene que seguir mostrando la fecha, no un
 * 46234. Se acepta además `dd/mm/aaaa` al leer, que es como se tipea acá.
 */

import { fail, isError, type FormulaFunction } from "../types.js";
import { toText } from "../values.js";
import { intArg, numberArg, scalarOf } from "./helpers.js";

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const LOCAL_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

/** UTC a propósito: sumar días no puede saltar por un cambio de huso. */
function parseDate(text: string): Date | null {
	const trimmed = text.trim();
	const iso = ISO_RE.exec(trimmed);
	if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));
	const local = LOCAL_RE.exec(trimmed);
	if (local) return build(Number(local[3]), Number(local[2]), Number(local[1]));
	return null;
}

function build(year: number, month: number, day: number): Date | null {
	const date = new Date(Date.UTC(year, month - 1, day));
	if (Number.isNaN(date.getTime())) return null;
	// Rechaza un 31 de febrero: `Date.UTC` lo corre al mes siguiente en silencio.
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date;
}

function formatDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

const MS_PER_DAY = 86_400_000;

/** Extrae una parte de la fecha del primer argumento. */
function part(name: string, help: string, pick: (date: Date) => number): FormulaFunction {
	return {
		name,
		minArgs: 1,
		maxArgs: 1,
		help,
		call: (args) => {
			const date = parseDate(toText(scalarOf(args[0])));
			return date ? pick(date) : fail("#VALUE!");
		},
	};
}

export const DATE_FUNCTIONS: readonly FormulaFunction[] = [
	{
		name: "TODAY",
		minArgs: 0,
		maxArgs: 0,
		help: "TODAY() — la fecha de hoy",
		volatile: true,
		call: (_args, ctx) => formatDate(ctx.now()),
	},
	{
		name: "NOW",
		minArgs: 0,
		maxArgs: 0,
		help: "NOW() — fecha y hora actuales",
		volatile: true,
		call: (_args, ctx) => ctx.now().toISOString().slice(0, 16).replace("T", " "),
	},
	{
		name: "DATE",
		minArgs: 3,
		maxArgs: 3,
		help: "DATE(año; mes; día) — arma una fecha",
		call: (args) => {
			const year = intArg(args[0]);
			if (isError(year)) return year;
			const month = intArg(args[1]);
			if (isError(month)) return month;
			const day = intArg(args[2]);
			if (isError(day)) return day;
			const date = build(year, month, day);
			return date ? formatDate(date) : fail("#VALUE!");
		},
	},
	part("YEAR", "YEAR(fecha) — el año", (date) => date.getUTCFullYear()),
	part("MONTH", "MONTH(fecha) — el mes (1-12)", (date) => date.getUTCMonth() + 1),
	part("DAY", "DAY(fecha) — el día del mes", (date) => date.getUTCDate()),
	part("WEEKDAY", "WEEKDAY(fecha) — día de la semana (1 = domingo)", (date) => date.getUTCDay() + 1),
	{
		name: "DAYS",
		minArgs: 2,
		maxArgs: 2,
		help: "DAYS(hasta; desde) — días entre dos fechas",
		call: (args) => {
			const end = parseDate(toText(scalarOf(args[0])));
			const start = parseDate(toText(scalarOf(args[1])));
			if (!end || !start) return fail("#VALUE!");
			return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
		},
	},
	{
		name: "EDATE",
		minArgs: 2,
		maxArgs: 2,
		help: "EDATE(fecha; meses) — corre la fecha esa cantidad de meses",
		call: (args) => {
			const date = parseDate(toText(scalarOf(args[0])));
			if (!date) return fail("#VALUE!");
			const months = intArg(args[1]);
			if (isError(months)) return months;
			const shifted = new Date(date.getTime());
			shifted.setUTCMonth(shifted.getUTCMonth() + months);
			return formatDate(shifted);
		},
	},
	{
		name: "ADDDAYS",
		minArgs: 2,
		maxArgs: 2,
		help: "ADDDAYS(fecha; días) — suma (o resta) días a una fecha",
		call: (args) => {
			const date = parseDate(toText(scalarOf(args[0])));
			if (!date) return fail("#VALUE!");
			const days = numberArg(args[1]);
			if (isError(days)) return days;
			return formatDate(new Date(date.getTime() + Math.round(days) * MS_PER_DAY));
		},
	},
];
