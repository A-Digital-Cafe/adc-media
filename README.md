# adc-media

UI library Stencil (`media-ui-library`, namespace `adc-platform`) con visores y
editores de documentos/multimedia federables vía custom elements + import map.
Sin puerto propio: la compila y sirve el kernel (UIFederationService).

**Componentes**: `adc-media-viewer` (imagen/video/audio), `adc-pdf-viewer` (nativo),
`adc-sheet-editor` (hoja de cálculo para `.csv` y `.adcsheet` —JSON Lines con
celdas extensibles por propiedades, ver `@common/types/adc-sheet`—: rótulos A/B/C
y números de fila pegajosos, scroll en ambos ejes, barra de celda, undo/redo con
delimitador, export csv/fods/adcsheet/md/html vía `utils/adcsheet`),
`adc-menu-bar` (barra de menús compartida de ambos editores + `.adc-editor-toolbar`),
`adc-document-editor`/`adc-document-renderer` (`.adcdoc`: un único
`adc-blocks-editor` con tablas, saltos de página y bloques con margen embebidos;
3 vistas de página —continuo / hojas / una hoja con anterior-siguiente, paginadas
midiendo el DOM en `document-pagination` según la configuración de página del
documento (A4/Carta/Oficio + márgenes en cm, también usada al imprimir)—, esquema
navegable, deshacer/rehacer y menús Archivo / Editar / Insertar (agrupado por
categorías); import/export desde el registro `utils/document-formats`
—.md/.txt/.csv in, .md/.txt/.html/.csv/imprimir-PDF out—; `fill` = alto del contenedor),
`adc-blocks-editor` (WYSIWYG; acepta los bloques extendidos de documento, expone
`insertBlock()`/`getFlowRoot()` y los modos `bare`/`stickyToolbar`),
`adc-blocks-renderer`, `adc-blocks-form`,
`adc-blocks-property-editor` (admin), átomos de bloque y utils
(`markdown-blocks`, `csv`, `adcdoc`, `doc-export`, `blocks-clipboard`).

**Consumir**: `"uiDependencies": ["adc-ui-library", "media-ui-library"]` +
`import "@media-ui-library";` en el entry (+ `@media-ui-library/utils/react-jsx`
para tipos). Requiere la lib principal cargada (átomos cross-lib). Integrado hoy
en: drive (media/pdf/csv/adcdoc), community-home (admin + artículos), help,
project-management, mail (preview de adjuntos). Sin cambios: my-account,
org-requests, status, notifications. Futuro: image-editor (previews), finances/chats
(adjuntos), import HTML, export `.fodt` (flat ODT), UI de merges/anchos en `table-x`.
