---
"@ifc-lite/mutations": patch
---

An edited quantity keeps its own `Unit`: `MutablePropertyView.getQuantitiesForEntity` now carries the base quantity's `explicitUnit`, `explicitUnitSiScale` and `explicitUnitUnresolved` through a value edit, so displays keep labelling it in that unit. They are dropped when the edit removes the unit, names its own unit or changes the quantity type.
