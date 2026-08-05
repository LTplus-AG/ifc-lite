---
"@ifc-lite/wasm": patch
---

The attribute export now reports the model's `UnitScales`.

`EntityRow` carries property and quantity values in the file's own units,
unlike the geometry exporters, which normalise to metres. The scales were
resolved internally and discarded, so a consumer writing quantities beside
exported geometry had a silent 1000x mismatch and nothing in the API to
detect it with. `build_export_model` returns them on `ExportModel.units`,
and both streaming entry points return them.
