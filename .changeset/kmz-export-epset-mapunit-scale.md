---
"@ifc-lite/viewer": patch
---

Fix KMZ export scaling a millimetre IFC2x3 project's `ePset_MapConversion` offsets by 1 instead of 0.001.

`kmzSuggestsAbsoluteAltitude` and `buildKmzForModel` (kmz-export.ts) built their `ProjectedCRS` via `extractGeoreferencingOnDemand` + `mergeProjectedCRS` directly, without the `resolveEpsetMapUnitScale` correction `getEffectiveGeoreference` applies for every other georeference consumer. For a file whose only georeference is an IFC2x3 `ePset_MapConversion` property set with no explicit `MapUnit` — the buildingSMART convention is to read those offsets in the project length unit — `mapUnitScale` stayed `undefined`, so `resolveMapUnitToMetreScale`'s "no MapUnit ⇒ treat offsets as metres" heuristic took over instead: eastings, northings and OrthogonalHeight were all read as metres rather than the project's millimetres, a 1000× error in every exported KMZ placement and the "True elevation (MSL)" altitude-mode hint. Both functions now apply `resolveEpsetMapUnitScale`, matching the correction `GeoreferencingPanel.tsx` already applies (#2859).
