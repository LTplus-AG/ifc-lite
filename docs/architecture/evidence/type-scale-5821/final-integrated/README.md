# Final type-scale stack visual check (#5821)

[Light](light.png) and [dark](dark.png) show the same 1440 × 900 viewer state on the final zero-arbitrary-font stack, including the touched-file accessibility cleanup. The built-in authored `building-architecture.ifc` sample loaded as one model with 14 meshes. A real click on the roof selected entity 425 (`IfcSlab`), and the Properties panel remained open in both themes.

Captured in headful Chrome with SwiftShader from the local Vite viewer. The disclosure toast was dismissed through its visible close button before capture. The document width was 1440 CSS pixels in both themes, with no horizontal overflow or page errors. The same selected element, panel and viewport were kept while changing only the theme.
