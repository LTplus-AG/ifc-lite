---
"@ifc-lite/wasm": patch
---

Export plans keep non-UTF-8 source records byte-identical, give an occurrence override the unit of the type record it replaces and leave an edited record's own unit alone, refuse Adds that break the spatial tree or IFC4 door/window typing, check property values against their measure type (binary literals included; aggregate types are refused), and report elements orphaned by a deleted storey and IFC2X3 types written without a relationship.
