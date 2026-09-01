---
'@ifc-lite/parser': patch
---

Fix `IfcComplexProperty` being silently mis-decoded by the on-demand STEP property extraction path (`extractPropertiesOnDemand`, `extractTypePropertiesOnDemand`, and the material-pset resolver in `on-demand-extractors.ts`).

`IfcComplexProperty`'s EXPRESS attributes are `[Name, Description, UsageName, HasProperties]` — the last a nested list of `IfcProperty` refs. The property-value parser's default branch, written for `IfcPropertySingleValue`, read attribute index 2 as a `NominalValue`; for a complex property that slot is `UsageName`, a label, not a value. So a complex property showed its `UsageName` string as if it were the value, and every nested property in `HasProperties` vanished from the panel/query output with no error.

`resolveComplexPropertyValue` (new, in `property-value-parser.ts`) now walks `HasProperties`, recursing into any further nested `IfcComplexProperty`, and produces a `"Name: value, ..."` display string plus a flat `values` candidate list (mirroring the existing enumerated/list/bounded/table-value handling). `parsePropertyValueWithComplex` dispatches to it for `IfcComplexProperty` and to the existing single-entity parser otherwise; both `columnar-parser.ts`'s `extractPropertiesOnDemand` and `on-demand-extractors.ts`'s pset/material-pset resolvers now call it instead of the single-entity parser directly.
