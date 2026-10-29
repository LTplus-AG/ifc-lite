---
"@ifc-lite/parser": minor
---

New `declareLengthUnitScale(entityIndex, scale)` for a format with no `IfcProject` to read a unit from (IFCX). `extractLengthUnitScale` and `resolveLengthUnit` answer the declared scale without the "No IFCPROJECT found, defaulting to meters" warning or diagnostic, still reporting `source: 'default'` because the file declares nothing. `IFCX_LENGTH_UNIT_SCALE` is re-exported, and `IfcDataStore` gains an optional `derivedEntities`.
