---
"@ifc-lite/export": patch
---

An IFC4 → IFC2X3 export with edits now resolves an `IfcMaterialProperties` whose material set lost a member that was created and then deleted in the same session. The deleted member is left out of the set, as the writer leaves it out of the list, so the record names the surviving layer's `IfcMaterial` instead of being dropped.
