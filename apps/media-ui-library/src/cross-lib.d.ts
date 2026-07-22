/**
 * Tags de la UI library principal (adc-ui-library) usados por componentes de
 * esta lib. Solo tipos: en runtime los custom elements ya están definidos
 * porque toda app de la plataforma carga la lib principal.
 */
declare module "@stencil/core" {
	export namespace JSX {
		interface CrossLibProps {
			[prop: string]: any;
		}
		interface IntrinsicElements {
			"adc-button": CrossLibProps;
			"adc-callout": CrossLibProps;
			"adc-checkbox": CrossLibProps;
			"adc-divider": CrossLibProps;
			"adc-input": CrossLibProps;
			"adc-quote": CrossLibProps;
			"adc-select": CrossLibProps;
			"adc-skeleton": CrossLibProps;
			"adc-textarea": CrossLibProps;
			"adc-toggle": CrossLibProps;
		}
	}
}
export {};
