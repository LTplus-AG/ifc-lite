---
"@ifc-lite/rhino3dm": patch
---

The IFC class lookups read the entity tables through their getters (`getEntitiesIfc4x3()`, `getEntitiesIfc4Express()`, `getEntitiesIfc2x3()`), so a bundle that includes the Rhino importer no longer keeps the eager table constants on its startup path. Same lookups, same results.
