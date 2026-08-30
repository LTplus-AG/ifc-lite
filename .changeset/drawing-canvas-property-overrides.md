---
"@ifc-lite/viewer": patch
---

The live 2D drawing canvas now resolves `ElementData.properties` for its graphic-override rules. It previously built `ElementData` with only `expressId`/`ifcType`, so a `property`/`propertySet`-gated rule could never win over its lower-priority base rule on screen. The built-in "Structural Highlight" preset's `LoadBearing` rule and "Fire Safety"'s `FireRating exists` fire-door rule now match where they silently matched nothing. Fire Safety's three fire-rating band rules compare `FireRating` with `greaterOrEqual`, which only matches a numeric value, so they still match nothing on a file that writes `FireRating` as the `IfcLabel` IFC4 specifies for it. This fixes the live canvas only; the SVG/PDF export paths still build `ElementData` without properties.

Properties are resolved once per (model set, polygon set) change via a new `useDrawingElementPropertiesLookup` hook, never inside the canvas's per-frame draw loop, and skipped entirely when no active rule uses a `property`/`propertySet` criterion. An entity carrying two property sets with the same name (a type-level and an occurrence-level `Pset_WallCommon`, say) keeps the properties of both, first match across the sequence winning.
