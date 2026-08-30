---
"@ifc-lite/viewer": patch
---

Wire the SVG/PDF drawing export's graphic-override engine up to real IFC property data, so `property`/`propertySet` criteria can match again.

`ElementData.properties` (`packages/drawing-2d/src/graphic-overrides/types.ts`) was declared and read by the rule engine's `property`/`propertySet` criteria (`rule-engine.ts`), but every construction site in `useDrawingExport.ts` built only `{ expressId, ifcType }` — the same gap #3520 found and removed for the sibling `materials`/`layers` fields. Unlike those two, this one is directly user-reachable: the built-in "Fire Safety" preset (selectable from the drawing settings panel's Style Presets list) colors walls and doors entirely by their `FireRating` property, and "Structural Highlight" has a `LoadBearing`-gated rule — both silently painted every element with their non-matching base style, no matter how it was rated.

`generateExportSVG` and `generateSheetSVG` now resolve each polygon's properties from the real parsed model before calling `applyOverrides`, via a new `makePropertiesGetter` (`hooks/drawingElementProperties.ts`) that caches per export pass and correctly resolves a federated drawing's global entity id back to its owning model's store (`fromGlobalIdFromModels`) before extracting.

The live on-screen 2D canvas (`Drawing2DCanvas.tsx`) is unchanged — like #3520 found for `materials`, it has no data-store reference in its hot per-frame render loop, and threading one through is a larger, separate change. So the Fire Safety and Structural presets now render correctly in the exported SVG, the sheet SVG, and the sheet PDF (which rasterizes the sheet SVG) — DXF export carries no fill/stroke color and was never affected — but not yet in the live on-screen preview; that asymmetry is a known follow-up, not a regression.
