---
"@ifc-lite/parser": minor
"@ifc-lite/lists": minor
---

Lists/Schedules now resolve Type-level properties and quantities on instance rows (#1745). A column mapped to a pset/qto that lives on an element's `IfcTypeProduct` (via `IfcRelDefinesByType`) — e.g. `Pset_WallCommon.FireRating` or `Qto_WallBaseQuantities.Width` defined once on `IfcWallType` — now falls back to the type when the instance has no local value, so it no longer renders a blank cell. Instance-level values still take precedence, and the same fallback applies to list filter conditions.

`@ifc-lite/parser` gains `extractTypeQuantitiesOnDemand` (and the `extractQsetsFromIds` helper) mirroring the existing `extractTypePropertiesOnDemand`. `@ifc-lite/lists` gains optional `getTypePropertySets` / `getTypeQuantitySets` accessors on `ListDataProvider`; providers that don't implement them keep their previous behaviour (no fallback).
