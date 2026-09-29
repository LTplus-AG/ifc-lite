---
"@ifc-lite/create": patch
---

`addMaterialLayerSetToStore` (and so `bim.store.addMaterialLayerSet`) now refuses a layer whose `Material` is not a live `IfcMaterial` (a layer set, an element, a missing id) before writing any layer. `IfcMaterialLayer.Material` is an `IfcMaterial`; anything else wrote a file other tools reject.
