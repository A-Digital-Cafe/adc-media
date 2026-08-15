/**
 * Modelo de valores del motor de fórmulas y contrato de las *strategies* de
 * función.
 *
 * Los errores son **valores**, no excepciones: se propagan por la expresión
 * igual que un número. Así una fórmula rota nunca tumba el render de la hoja y
 * `IFERROR` puede atraparla sin `try/catch`.
 */

/** Códigos de error, con los mismos nombres que usa cualquier hoja de cálculo. */
export type ErrorCode = "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#N/A" | "#NUM!" | "#CIRC!" | "#SPILL!" | "#LIMIT!";

/** Error de fórmula. Marca `err` para distinguirlo de un string cualquiera. */
export interface FormulaError {
	readonly err: ErrorCode;
}

/** Valor de una celda ya evaluada. `null` = celda vacía. */
export type Scalar = number | string | boolean | null | FormulaError;

/** Resultado de una función: un escalar o una matriz (que se derrama). */
export type FormulaValue = Scalar | Scalar[][];

export function fail(code: ErrorCode): FormulaError {
	return { err: code };
}

export function isError(value: unknown): value is FormulaError {
	return typeof value === "object" && value !== null && typeof (value as FormulaError).err === "string";
}

/** Argumento escalar de una función. */
export interface ScalarArg {
	kind: "scalar";
	value: Scalar;
}

/**
 * Argumento de rango: además de los valores lleva su ancla en la hoja, que es
 * lo que permite a `FILTER`/`GROUPBY` resolver una columna por su letra real
 * (`"C>100"`) y no sólo por su posición dentro del rango.
 */
export interface RangeArg {
	kind: "range";
	/** Fila y columna (0-based) de la celda superior-izquierda del rango. */
	top: number;
	left: number;
	values: Scalar[][];
}

export type Arg = ScalarArg | RangeArg;

/** Topes de una evaluación: ninguna fórmula puede colgar la pestaña. */
export interface EvalLimits {
	/** Celdas que puede tocar un rango (y tamaño máximo de un derrame). */
	maxRangeCells: number;
	/** Filas que puede producir una función de derrame. */
	maxSpillRows: number;
	/** Columnas que puede producir una función de derrame. */
	maxSpillCols: number;
}

export interface CallCtx {
	limits: EvalLimits;
	/** Celda que contiene la fórmula (`ROW()`/`COLUMN()` sin argumentos). */
	self: { r: number; c: number };
	/** Reloj inyectado: mantiene `TODAY()`/`NOW()` testeables y en un solo lugar. */
	now: () => Date;
}

/**
 * Strategy de una función. Agregar una función = agregar una entrada al array
 * de su dominio (`functions/…`); el registro y la validación de aridad son
 * comunes y no hay ramas por nombre en el evaluador.
 */
export interface FormulaFunction {
	readonly name: string;
	readonly minArgs: number;
	/** `Infinity` para variádicas. */
	readonly maxArgs: number;
	/** Ayuda corta que se muestra en el menú de funciones. */
	readonly help: string;
	/** Devuelve una matriz que ocupa las celdas de abajo/derecha. */
	readonly spills?: boolean;
	/** Depende del reloj: su resultado nunca se cachea. */
	readonly volatile?: boolean;
	/** Recibe los errores en vez de cortocircuitar (`IFERROR`, `ISERROR`, `IF`). */
	readonly acceptsErrors?: boolean;
	call(args: Arg[], ctx: CallCtx): FormulaValue;
}
