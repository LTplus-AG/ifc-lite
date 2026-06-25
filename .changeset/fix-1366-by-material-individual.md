---
"@ifc-lite/lens": minor
---

"Color/select by Material" now groups by individual materials instead of the layer-set / usage name. A multi-layer element (e.g. a wall of gypsum board + insulation) now belongs to each of its materials' groups, so selecting "gypsum board" isolates every wall containing it — including multi-layer walls — and the legend lists the real materials rather than the Revit family/type string. Material rule criteria (`materialName`) match the same way. Adds an optional `LensDataProvider.getMaterialNames(globalId)` accessor; providers without it fall back to the previous single `getMaterialName` value. (#1366)
