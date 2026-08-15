/**
 * Registro de funciones: el evaluador no conoce ninguna por nombre, sólo
 * busca acá. Agregar una función = agregar una entrada al array de su dominio;
 * agregar un dominio = sumarlo a `DOMAINS`.
 */

import type { FormulaFunction } from "../types.js";
import { MATH_FUNCTIONS, MATH_ALIASES } from "./math.js";
import { STATS_FUNCTIONS, STATS_ALIASES } from "./stats.js";
import { TEXT_FUNCTIONS, TEXT_ALIASES } from "./text.js";
import { LOGIC_FUNCTIONS } from "./logic.js";
import { LOOKUP_FUNCTIONS } from "./lookup.js";
import { DATE_FUNCTIONS } from "./datetime.js";
import { QUERY_FUNCTIONS } from "./query.js";

/** Dominios en el orden en que se muestran en el menú "Funciones". */
export const FUNCTION_DOMAINS: ReadonlyArray<{ label: string; functions: readonly FormulaFunction[] }> = [
	{ label: "Agregación", functions: STATS_FUNCTIONS },
	{ label: "Consulta (derraman filas)", functions: QUERY_FUNCTIONS },
	{ label: "Matemáticas", functions: MATH_FUNCTIONS },
	{ label: "Texto", functions: TEXT_FUNCTIONS },
	{ label: "Lógica", functions: LOGIC_FUNCTIONS },
	{ label: "Búsqueda", functions: LOOKUP_FUNCTIONS },
	{ label: "Fechas", functions: DATE_FUNCTIONS },
];

const ALIASES: Readonly<Record<string, string>> = { ...MATH_ALIASES, ...STATS_ALIASES, ...TEXT_ALIASES };

const REGISTRY = new Map<string, FormulaFunction>();
for (const domain of FUNCTION_DOMAINS) {
	for (const fn of domain.functions) REGISTRY.set(fn.name, fn);
}
for (const [alias, target] of Object.entries(ALIASES)) {
	const fn = REGISTRY.get(target);
	if (fn) REGISTRY.set(alias, fn);
}

/** Busca una función por nombre (ya en mayúsculas) o alias. */
export function findFunction(name: string): FormulaFunction | undefined {
	return REGISTRY.get(name);
}
