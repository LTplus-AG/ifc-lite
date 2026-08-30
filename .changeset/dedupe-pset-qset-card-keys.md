---
"@ifc-lite/viewer": patch
---

Fix duplicate React keys (and a matching console warning) when an entity carries two property sets or quantity sets with the same name — a legitimate IFC model shape (two `IfcPropertySet`/`IfcElementQuantity` entities sharing a `Name`, including an empty `""` name). The Properties/Quantities panel, model metadata panel, and material totals panel now key each card by its position in the list plus its name, so both cards render with their own properties/quantities instead of one silently dropping or being mis-associated with the other.
