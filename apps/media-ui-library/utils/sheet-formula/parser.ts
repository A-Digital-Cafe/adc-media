/**
 * Lexer + parser descendente recursivo de la sintaxis de fórmulas.
 *
 * Gramática (de menor a mayor precedencia):
 *   comparación (`=` `<>` `<` `>` `<=` `>=`) → concatenación (`&`) →
 *   suma/resta → producto/división → potencia (`^`) → unario (`-`/`+`) →
 *   porcentaje sufijo (`50%`) → primario.
 *
 * Separador de argumentos: `,` o `;` (los teclados/locales de la región usan
 * cualquiera de los dos; aceptar ambos evita una fórmula "rota" por copiar y
 * pegar desde otra planilla).
 *
 * El parseo NO evalúa: es barato y por eso se puede hacer sólo para saber de
 * qué celdas depende una fórmula (lo que valida la caché sin recalcular).
 */

import { parseRef, columnIndex } from "./refs.js";

export type Node =
	| { t: "num"; v: number }
	| { t: "str"; v: string }
	| { t: "bool"; v: boolean }
	| { t: "ref"; r: number; c: number }
	/** Rango rectangular ya normalizado (r1 ≤ r2, c1 ≤ c2). `r2 = null` = columna entera. */
	| { t: "range"; r1: number; c1: number; r2: number | null; c2: number }
	| { t: "un"; op: "-" | "+"; a: Node }
	| { t: "pct"; a: Node }
	| { t: "bin"; op: BinaryOp; a: Node; b: Node }
	| { t: "call"; name: string; args: Node[] };

export type BinaryOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

interface Token {
	kind: "num" | "str" | "name" | "func" | "ref" | "op" | "(" | ")" | "," | ":";
	text: string;
	value?: number;
}

// `%` sale del lexer como operador pero sólo lo consume el nivel sufijo (`50%`):
// no hay ningún nivel binario que lo liste, así que `1 % 2` es un error de sintaxis.
const OPERATORS = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "&", "=", "<", ">", "%"];

/** Lanza este error el parser; el evaluador lo traduce a `#NAME?`. */
export class ParseError extends Error {}

const NUMBER_RE = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/;
const WORD_RE = /^[A-Za-z_$][A-Za-z0-9_$.]*/;
const SPACE_RE = /\s/;

/** Literal de texto: devuelve el contenido y cuántos caracteres consumió. */
function readString(source: string, start: number): { text: string; length: number } {
	let text = "";
	let i = start + 1;
	while (i < source.length) {
		if (source[i] === '"') {
			// `""` dentro de un literal es una comilla escapada, no el cierre.
			if (source[i + 1] !== '"') return { text, length: i + 1 - start };
			text += '"';
			i += 2;
			continue;
		}
		text += source[i++];
	}
	throw new ParseError("comilla sin cerrar");
}

/**
 * Palabra: función, referencia o nombre suelto. El `(` que viene después es lo
 * único que distingue `LOG10(` (función) de `LOG10` (referencia a la celda).
 */
function readWord(source: string, start: number, word: string): Token {
	if (source.slice(start + word.length).trimStart().startsWith("(")) {
		return { kind: "func", text: word.replaceAll("$", "").toUpperCase() };
	}
	return parseRef(word) ? { kind: "ref", text: word } : { kind: "name", text: word };
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		const rest = source.slice(i);

		if (SPACE_RE.test(ch)) {
			i++;
		} else if (ch === '"') {
			const literal = readString(source, i);
			tokens.push({ kind: "str", text: literal.text });
			i += literal.length;
		} else if (NUMBER_RE.test(rest)) {
			const [text] = NUMBER_RE.exec(rest)!;
			tokens.push({ kind: "num", text, value: Number(text) });
			i += text.length;
		} else if (ch === "(" || ch === ")" || ch === ":") {
			tokens.push({ kind: ch, text: ch });
			i++;
		} else if (ch === "," || ch === ";") {
			// Los dos separadores conviven: cada teclado/locale usa el suyo.
			tokens.push({ kind: ",", text: ch });
			i++;
		} else if (WORD_RE.test(rest)) {
			const [word] = WORD_RE.exec(rest)!;
			tokens.push(readWord(source, i, word));
			i += word.length;
		} else {
			const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
			if (!op) throw new ParseError(`carácter inesperado: ${ch}`);
			tokens.push({ kind: "op", text: op });
			i += op.length;
		}
	}
	return tokens;
}

class Parser {
	readonly #tokens: Token[];
	#pos = 0;

	constructor(tokens: Token[]) {
		this.#tokens = tokens;
	}

	#peek(offset = 0): Token | undefined {
		return this.#tokens[this.#pos + offset];
	}

	/** Consume el siguiente token si es del tipo pedido. */
	#eat(kind: Token["kind"]): boolean {
		if (this.#peek()?.kind !== kind) return false;
		this.#pos++;
		return true;
	}

	parse(): Node {
		const node = this.#comparison();
		if (this.#pos < this.#tokens.length) throw new ParseError(`sobra "${this.#peek()!.text}"`);
		return node;
	}

	#binaryLevel(ops: readonly BinaryOp[], next: () => Node): Node {
		let left = next();
		for (;;) {
			const token = this.#peek();
			if (token?.kind !== "op" || !ops.includes(token.text as BinaryOp)) return left;
			this.#pos++;
			left = { t: "bin", op: token.text as BinaryOp, a: left, b: next() };
		}
	}

	#comparison(): Node {
		return this.#binaryLevel(["=", "<>", "<", ">", "<=", ">="], () => this.#concat());
	}

	#concat(): Node {
		return this.#binaryLevel(["&"], () => this.#additive());
	}

	#additive(): Node {
		return this.#binaryLevel(["+", "-"], () => this.#multiplicative());
	}

	#multiplicative(): Node {
		return this.#binaryLevel(["*", "/"], () => this.#power());
	}

	/** `^` asocia a derecha: `2^3^2` es `2^(3^2)`. */
	#power(): Node {
		const base = this.#unary();
		const token = this.#peek();
		if (token?.kind === "op" && token.text === "^") {
			this.#pos++;
			return { t: "bin", op: "^", a: base, b: this.#power() };
		}
		return base;
	}

	#unary(): Node {
		const token = this.#peek();
		if (token?.kind === "op" && (token.text === "-" || token.text === "+")) {
			this.#pos++;
			return { t: "un", op: token.text, a: this.#unary() };
		}
		return this.#postfix();
	}

	#postfix(): Node {
		let node = this.#primary();
		// `%` es sufijo y encadenable: `50%%` es 0,005.
		while (this.#peek()?.kind === "op" && this.#peek()!.text === "%") {
			this.#pos++;
			node = { t: "pct", a: node };
		}
		return node;
	}

	#primary(): Node {
		const token = this.#peek();
		if (!token) throw new ParseError("fórmula incompleta");

		if (token.kind === "num") {
			this.#pos++;
			return { t: "num", v: token.value! };
		}
		if (token.kind === "str") {
			this.#pos++;
			return { t: "str", v: token.text };
		}
		if (token.kind === "(") {
			this.#pos++;
			const inner = this.#comparison();
			if (!this.#eat(")")) throw new ParseError("falta )");
			return inner;
		}
		if (token.kind === "func") return this.#call();
		if (token.kind === "ref") return this.#refOrRange();
		if (token.kind === "name") return this.#nameOrColumnRange();
		throw new ParseError(`token inesperado: ${token.text}`);
	}

	#call(): Node {
		const name = this.#tokens[this.#pos++].text;
		if (!this.#eat("(")) throw new ParseError(`falta ( en ${name}`);
		const args: Node[] = [];
		if (!this.#eat(")")) {
			do {
				args.push(this.#comparison());
			} while (this.#eat(","));
			if (!this.#eat(")")) throw new ParseError(`falta ) en ${name}`);
		}
		return { t: "call", name, args };
	}

	#refOrRange(): Node {
		const start = parseRef(this.#tokens[this.#pos++].text)!;
		if (this.#peek()?.kind === ":" && this.#peek(1)?.kind === "ref") {
			this.#pos++;
			const end = parseRef(this.#tokens[this.#pos++].text)!;
			return {
				t: "range",
				r1: Math.min(start.r, end.r),
				c1: Math.min(start.c, end.c),
				r2: Math.max(start.r, end.r),
				c2: Math.max(start.c, end.c),
			};
		}
		return { t: "ref", r: start.r, c: start.c };
	}

	/**
	 * `TRUE`/`FALSE`, o una columna entera (`A:C`, que se resuelve contra el alto
	 * real de la grilla). Cualquier otro nombre suelto es `#NAME?`.
	 */
	#nameOrColumnRange(): Node {
		const token = this.#tokens[this.#pos++];
		const upper = token.text.toUpperCase();
		if (upper === "TRUE") return { t: "bool", v: true };
		if (upper === "FALSE") return { t: "bool", v: false };

		const next = this.#peek();
		const after = this.#peek(1);
		if (next?.kind === ":" && after?.kind === "name") {
			const c1 = columnIndex(token.text.replaceAll("$", ""));
			const c2 = columnIndex(after.text.replaceAll("$", ""));
			if (c1 >= 0 && c2 >= 0) {
				this.#pos += 2;
				return { t: "range", r1: 0, c1: Math.min(c1, c2), r2: null, c2: Math.max(c1, c2) };
			}
		}
		throw new ParseError(`nombre desconocido: ${token.text}`);
	}
}

/** Parsea el cuerpo de una fórmula (sin el `=` inicial). Lanza `ParseError`. */
export function parseFormula(body: string): Node {
	return new Parser(tokenize(body)).parse();
}
