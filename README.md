# adc-media

UI library Stencil (`media-ui-library`, namespace `adc-platform`) con visores y
editores de documentos/multimedia reutilizables desde cualquier app de la
plataforma: `adc-media-viewer` (imagen/video/audio), `adc-pdf-viewer`.

Las apps consumidoras declaran `"uiDependencies": ["adc-ui-library", "media-ui-library"]`
y agregan `import "@media-ui-library";` en su entry. La lib no usa puerto propio:
la compila y sirve el kernel (UIFederationService).

Requiere la UI library principal (`adc-ui-library`) cargada — sus átomos se usan
cross-lib. Si este preset no está clonado, las apps degradan sin crash (tags sin
definir).
