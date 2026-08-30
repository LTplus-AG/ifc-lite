---
"@ifc-lite/viewer": patch
---

The live 2D drawing canvas now resolves `ElementData.properties` for its graphic-override rules, so the built-in "Fire Safety" (`FireRating`) and "Structural Highlight" (`LoadBearing`) presets actually change what's drawn on screen when clicked, not just in the exported SVG/PDF (the export paths — SVG/PDF — are handled separately in #3523; the canvas previously built `ElementData` with only `expressId`/`ifcType`, so a `property`/`propertySet`-gated rule could never win over its base rule).

Properties are resolved once per (model set, polygon set) change via a new `useDrawingElementPropertiesLookup` hook — never inside the canvas's per-frame draw loop, and skipped entirely when no active rule uses a `property`/`propertySet` criterion.
