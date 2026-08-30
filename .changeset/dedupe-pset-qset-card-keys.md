---
"@ifc-lite/viewer": patch
---

Fix duplicate React keys (and the matching dev-mode console warning) when an entity carries two property sets or quantity sets with the same name. That is a legitimate IFC model shape: two `IfcPropertySet` or `IfcElementQuantity` entities can share a `Name`, including an empty `""` name. The Properties/Quantities panel, model metadata panel and material totals panel now key each card by its position in the list plus its name, and a property set's own rows are keyed the same way, so every key is unique among its siblings. Both cards already rendered their own properties before this change, so what it closes is the console warning plus the reconciliation behaviour React documents as unsupported for duplicate sibling keys, not a reproduced dropped card.
