---
"@ifc-lite/data": minor
---

`Quantity` declares the optional `explicitUnit`, `explicitUnitSiScale` and `explicitUnitUnresolved` fields the quantity collector already attaches to a quantity with its own `Unit`, so code that rebuilds a quantity (such as the mutations overlay) carries them typed instead of dropping them.
