# Georeference fields and type scale (#5821)

`after.png` is a 1440×900 Chrome capture of the expanded Projected CRS fields in the Properties pane after loading `/samples/building-architecture.ifc`. The IFC header names SketchUp 2024 and IFC-manager for SketchUp 5.3.3. The viewer parsed 444 entities and 12 geometry elements. The 12 px field labels and values remain legible in the 320 px pane; the long CRS description wraps without covering adjacent controls. Chrome used the SwiftShader WebGPU flags from `viewer-e2e-ci`.

The editable field controls moved from the 985-line `GeoreferencingPanel` to `GeoreferenceFields`, a small local module. Mounted tests drive Enter/Space editing, focus, suggestion selection and cancellation, and the independent terrain action. The module-size budget is lowered to the measured panel length.
