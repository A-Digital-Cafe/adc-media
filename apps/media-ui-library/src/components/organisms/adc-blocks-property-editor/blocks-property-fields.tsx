import type { FunctionalComponent } from "@stencil/core";
import type { Block, CalloutRole, CalloutTone, TextAlign, TextMark } from "@common/ADC/types/learning.js";

/**
 * Formularios de propiedades por tipo de bloque (port Stencil del admin
 * BlocksEditor de community-home). Componentes funcionales puros: reciben el
 * bloque y un callback `onPatch` con el bloque completo actualizado.
 */

type BlockOf<T extends Block["type"]> = Extract<Block, { type: T }>;

interface FieldsProps<T extends Block> {
	block: T;
	onPatch: (next: T) => void;
}

const inputCls = "w-full p-2 rounded-xxl border border-surface-alt bg-surface";
const labelCls = "flex flex-col gap-1 text-sm";

const headingLevels: BlockOf<"heading">["level"][] = [2, 3, 4, 5, 6];
const textAligns: TextAlign[] = ["left", "center", "right"];
const textMarks: TextMark[] = ["bold", "italic", "code"];
const calloutTones: CalloutTone[] = ["info", "warning", "success", "error"];
const calloutRoles: CalloutRole[] = ["note", "status", "alert"];

function alignLabel(align: TextAlign): string {
	if (align === "left") return "Izquierda";
	if (align === "center") return "Centro";
	return "Derecha";
}

function titleCase(value: string): string {
	return value[0].toUpperCase() + value.slice(1);
}

const inputValue = (ev: globalThis.Event): string => (ev.target as HTMLInputElement).value;
const inputChecked = (ev: globalThis.Event): boolean => (ev.target as HTMLInputElement).checked;

const AlignSelect: FunctionalComponent<{ value?: TextAlign; onSelect: (align: TextAlign) => void }> = ({ value, onSelect }) => (
	<label class={labelCls}>
		<span>Alineación</span>
		<select class={inputCls} onChange={(ev: globalThis.Event) => onSelect(inputValue(ev) as TextAlign)}>
			{textAligns.map((align) => (
				<option key={align} value={align} selected={(value ?? "left") === align}>
					{alignLabel(align)}
				</option>
			))}
		</select>
	</label>
);

const MarksFieldset: FunctionalComponent<{ marks?: TextMark[]; onMarks: (marks: TextMark[]) => void }> = ({ marks, onMarks }) => (
	<fieldset class="flex gap-3 text-sm">
		<legend class="sr-only">Marcas</legend>
		{textMarks.map((mark) => {
			const current = marks ?? [];
			return (
				<label key={mark} class="flex items-center gap-1">
					<input
						type="checkbox"
						checked={current.includes(mark)}
						onChange={(ev: globalThis.Event) =>
							onMarks(inputChecked(ev) ? [...current, mark] : current.filter((item) => item !== mark))
						}
					/>
					<span>{mark}</span>
				</label>
			);
		})}
	</fieldset>
);

const HeadingFields: FunctionalComponent<FieldsProps<BlockOf<"heading">>> = ({ block, onPatch }) => (
	<div class="flex flex-col gap-2">
		<label class={labelCls}>
			<span>Texto</span>
			<input class={inputCls} value={block.text ?? ""} onInput={(ev: globalThis.Event) => onPatch({ ...block, text: inputValue(ev) })} />
		</label>
		<div class="grid grid-cols-3 gap-2">
			<label class={labelCls}>
				<span>Nivel</span>
				<select
					class={inputCls}
					onChange={(ev: globalThis.Event) => onPatch({ ...block, level: Number(inputValue(ev)) as BlockOf<"heading">["level"] })}
				>
					{headingLevels.map((level) => (
						<option key={level} value={level} selected={(block.level ?? 2) === level}>
							H{level}
						</option>
					))}
				</select>
			</label>
			<AlignSelect value={block.align} onSelect={(align) => onPatch({ ...block, align })} />
			<label class={labelCls}>
				<span>ID (ancla)</span>
				<input class={inputCls} value={block.id ?? ""} onInput={(ev: globalThis.Event) => onPatch({ ...block, id: inputValue(ev) })} />
			</label>
		</div>
	</div>
);

const ParagraphFields: FunctionalComponent<FieldsProps<BlockOf<"paragraph">>> = ({ block, onPatch }) => (
	<div class="flex flex-col gap-2">
		<label class={labelCls}>
			<span>Texto</span>
			<textarea class={inputCls} rows={4} onInput={(ev: globalThis.Event) => onPatch({ ...block, text: inputValue(ev) })}>
				{block.text ?? ""}
			</textarea>
		</label>
		<AlignSelect value={block.align} onSelect={(align) => onPatch({ ...block, align })} />
		<MarksFieldset marks={block.marks} onMarks={(marks) => onPatch({ ...block, marks })} />
	</div>
);

const CheckboxFields: FunctionalComponent<FieldsProps<BlockOf<"checkbox">>> = ({ block, onPatch }) => (
	<div class="flex flex-col gap-2">
		<label class="flex items-center gap-2 text-sm font-medium">
			<input
				type="checkbox"
				checked={block.checked ?? false}
				onChange={(ev: globalThis.Event) => onPatch({ ...block, checked: inputChecked(ev) })}
				class="w-4 h-4 accent-primary"
			/>
			<span>Activo / Completado</span>
		</label>
		<label class={labelCls}>
			<span>Texto</span>
			<textarea class={inputCls} rows={2} onInput={(ev: globalThis.Event) => onPatch({ ...block, text: inputValue(ev) })}>
				{block.text ?? ""}
			</textarea>
		</label>
		<AlignSelect value={block.align} onSelect={(align) => onPatch({ ...block, align })} />
		<MarksFieldset marks={block.marks} onMarks={(marks) => onPatch({ ...block, marks })} />
	</div>
);

const ListFields: FunctionalComponent<FieldsProps<BlockOf<"list">>> = ({ block, onPatch }) => (
	<div class="flex flex-col gap-2">
		<label class="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={block.ordered === true}
				onChange={(ev: globalThis.Event) => onPatch({ ...block, ordered: inputChecked(ev) })}
			/>
			<span>Ordenada</span>
		</label>
		<label class={labelCls}>
			<span>Ítems (uno por línea)</span>
			<textarea
				class={inputCls}
				rows={5}
				onInput={(ev: globalThis.Event) =>
					onPatch({
						...block,
						items: inputValue(ev)
							.split("\n")
							.filter((value, index, values) => value !== "" || index < values.length - 1),
					})
				}
			>
				{(block.items ?? []).join("\n")}
			</textarea>
		</label>
		{block.ordered && (
			<label class={labelCls}>
				<span>Inicio</span>
				<input
					type="number"
					class={inputCls}
					value={block.start ?? 1}
					onInput={(ev: globalThis.Event) => onPatch({ ...block, start: Number(inputValue(ev)) })}
				/>
			</label>
		)}
	</div>
);

const CodeFields: FunctionalComponent<FieldsProps<BlockOf<"code">>> = ({ block, onPatch }) => (
	<div class="flex flex-col gap-2">
		<label class={labelCls}>
			<span>Lenguaje</span>
			<input
				class={inputCls}
				value={block.language ?? ""}
				placeholder="typescript, bash, json..."
				onInput={(ev: globalThis.Event) => onPatch({ ...block, language: inputValue(ev) })}
			/>
		</label>
		<label class={labelCls}>
			<span>Contenido</span>
			<textarea
				class={`${inputCls} font-mono text-sm`}
				rows={8}
				onInput={(ev: globalThis.Event) => onPatch({ ...block, content: inputValue(ev) })}
			>
				{block.content ?? ""}
			</textarea>
		</label>
	</div>
);

const CalloutFields: FunctionalComponent<FieldsProps<BlockOf<"callout">>> = ({ block, onPatch }) => (
	<div class="flex flex-col gap-2">
		<label class={labelCls}>
			<span>Texto</span>
			<textarea class={inputCls} rows={3} onInput={(ev: globalThis.Event) => onPatch({ ...block, text: inputValue(ev) })}>
				{block.text ?? ""}
			</textarea>
		</label>
		<div class="grid grid-cols-2 gap-2">
			<label class={labelCls}>
				<span>Tono</span>
				<select class={inputCls} onChange={(ev: globalThis.Event) => onPatch({ ...block, tone: inputValue(ev) as CalloutTone })}>
					{calloutTones.map((tone) => (
						<option key={tone} value={tone} selected={(block.tone ?? "info") === tone}>
							{titleCase(tone)}
						</option>
					))}
				</select>
			</label>
			<label class={labelCls}>
				<span>Role</span>
				<select class={inputCls} onChange={(ev: globalThis.Event) => onPatch({ ...block, role: inputValue(ev) as CalloutRole })}>
					{calloutRoles.map((role) => (
						<option key={role} value={role} selected={(block.role ?? "note") === role}>
							{titleCase(role)}
						</option>
					))}
				</select>
			</label>
		</div>
	</div>
);

const QuoteFields: FunctionalComponent<FieldsProps<BlockOf<"quote">>> = ({ block, onPatch }) => (
	<div class="flex flex-col gap-2">
		<label class={labelCls}>
			<span>Texto</span>
			<textarea class={inputCls} rows={3} onInput={(ev: globalThis.Event) => onPatch({ ...block, text: inputValue(ev) })}>
				{block.text ?? ""}
			</textarea>
		</label>
		<label class={labelCls}>
			<span>URL de fuente (opcional)</span>
			<input class={inputCls} value={block.url ?? ""} onInput={(ev: globalThis.Event) => onPatch({ ...block, url: inputValue(ev) })} />
		</label>
	</div>
);

const TableFields: FunctionalComponent<FieldsProps<BlockOf<"table">>> = ({ block, onPatch }) => (
	<div class="flex flex-col gap-2">
		<label class={labelCls}>
			<span>Encabezados (separados por |)</span>
			<input
				class={inputCls}
				value={(block.header ?? []).join(" | ")}
				onInput={(ev: globalThis.Event) => onPatch({ ...block, header: inputValue(ev).split("|").map((part) => part.trim()) })}
			/>
		</label>
		<label class={labelCls}>
			<span>Filas (una por línea, celdas separadas por |)</span>
			<textarea
				class={`${inputCls} font-mono text-sm`}
				rows={6}
				onInput={(ev: globalThis.Event) =>
					onPatch({ ...block, rows: inputValue(ev).split("\n").map((line) => line.split("|").map((part) => part.trim())) })
				}
			>
				{(block.rows ?? []).map((row) => row.join(" | ")).join("\n")}
			</textarea>
		</label>
		<label class={labelCls}>
			<span>Caption</span>
			<input
				class={inputCls}
				value={block.caption ?? ""}
				onInput={(ev: globalThis.Event) => onPatch({ ...block, caption: inputValue(ev) })}
			/>
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={block.rowHeaders === true}
				onChange={(ev: globalThis.Event) => onPatch({ ...block, rowHeaders: inputChecked(ev) })}
			/>
			<span>Primera columna como encabezado</span>
		</label>
	</div>
);

/** Formulario de propiedades para un bloque; `null` para tipos sin propiedades. */
export const BlockPropertyFields: FunctionalComponent<{ block: Block; onPatch: (next: Block) => void }> = ({ block, onPatch }) => {
	switch (block.type) {
		case "heading":
			return <HeadingFields block={block} onPatch={onPatch} />;
		case "paragraph":
			return <ParagraphFields block={block} onPatch={onPatch} />;
		case "checkbox":
			return <CheckboxFields block={block} onPatch={onPatch} />;
		case "list":
			return <ListFields block={block} onPatch={onPatch} />;
		case "code":
			return <CodeFields block={block} onPatch={onPatch} />;
		case "callout":
			return <CalloutFields block={block} onPatch={onPatch} />;
		case "quote":
			return <QuoteFields block={block} onPatch={onPatch} />;
		case "table":
			return <TableFields block={block} onPatch={onPatch} />;
		case "divider":
			return <p class="text-muted text-sm">Este bloque no tiene propiedades configurables.</p>;
		default:
			return <p class="text-tdanger text-sm">Tipo de bloque desconocido.</p>;
	}
};

interface BlockTypeOption {
	type: Block["type"];
	label: string;
	icon: string;
	create: () => Block;
}

/** Tipos de bloque insertables desde el menú del editor de propiedades. */
export const BLOCK_TYPE_OPTIONS: readonly BlockTypeOption[] = [
	{ type: "heading", label: "Encabezado", icon: "H", create: () => ({ type: "heading", level: 2, text: "Nuevo título" }) },
	{ type: "paragraph", label: "Párrafo", icon: "¶", create: () => ({ type: "paragraph", text: "Escribe aquí..." }) },
	{ type: "list", label: "Lista", icon: "•", create: () => ({ type: "list", ordered: false, items: ["Ítem 1"] }) },
	{ type: "code", label: "Código", icon: "</>", create: () => ({ type: "code", language: "typescript", content: "// código" }) },
	{ type: "callout", label: "Callout", icon: "!", create: () => ({ type: "callout", tone: "info", role: "note", text: "Nota destacada" }) },
	{ type: "quote", label: "Cita", icon: "❝", create: () => ({ type: "quote", text: "Texto citado" }) },
	{ type: "table", label: "Tabla", icon: "⊞", create: () => ({ type: "table", header: ["Col 1", "Col 2"], rows: [["a", "b"]] }) },
	{ type: "divider", label: "Divisor", icon: "—", create: () => ({ type: "divider" }) },
	{ type: "checkbox", label: "Checkbox", icon: "☑", create: () => ({ type: "checkbox", checked: false, text: "Escribe aquí..." }) },
];
