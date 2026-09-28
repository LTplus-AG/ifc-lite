---
"@ifc-lite/renderer": patch
---

Mark `VisualEnhancementOptions.edgeContrast` `@deprecated`: it has had no effect since #5746 removed the in-shader derivative edge darkening. Edges come from the screen-space edge pass, controlled by `separationLines`. The option is kept so existing settings still type-check.
