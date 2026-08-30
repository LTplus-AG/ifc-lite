---
'@ifc-lite/drawing-2d': patch
---

Fix `SVGExporter.export()` silently rendering (and labelling) a drawing at 1:50 instead of the scale it was actually configured at, whenever `drawing.config.scale` was a custom factor not among the ten `COMMON_SCALES` presets (e.g. 1:75, which `createSectionConfig(axis, position, { scale: 75 })` accepts — `SectionConfig.scale` is a plain `number`, not one of the presets). The default `scale` option looked the factor up with `COMMON_SCALES.find(...) || COMMON_SCALES[5]`, so a `.find()` miss on a legitimate custom scale was indistinguishable from "no scale option was passed" and both fell to the same hardcoded default — no error, no warning, and a title-block "Scale:" label that claimed the wrong scale had been honoured. A custom factor now gets a synthetic `DrawingScale` built from that factor; the 1:50 default remains only for a genuinely invalid (non-finite or non-positive) `config.scale`.
