---
"@ifc-lite/viewer": patch
---

Wire the SVG/PDF drawing export's graphic-override engine up to real IFC property data, so `property`/`propertySet` criteria can match again.

`ElementData.properties` (`packages/drawing-2d/src/graphic-overrides/types.ts`) was declared and read by the rule engine's `property`/`propertySet` criteria (`rule-engine.ts`), but every construction site in `useDrawingExport.ts` built only `{ expressId, ifcType }`, the same gap #3520 found and removed for the sibling `materials`/`layers` fields. Unlike those two this one is directly user-reachable: the built-in "Fire Safety" and "Structural Highlight" presets (selectable from the drawing settings panel's Style Presets list) gate rules on `FireRating`, `OccupancyType` and `LoadBearing`, and every one of those rules silently painted its elements with the non-matching base style.

`generateExportSVG` and `generateSheetSVG` now resolve each polygon's properties from the real parsed model before calling `applyOverrides`, via a new `makePropertiesGetter` (`hooks/drawingElementProperties.ts`) that caches per export pass and resolves a federated drawing's global entity id back to its owning model's store (`fromGlobalIdFromModels`) before extracting.

What this turns on, and what it does not. Fire Safety's "Fire Doors" rule (`FireRating exists`), its "Escape Routes" rule (`OccupancyType contains`), Structural Highlight's "Load-bearing Walls" rule (`LoadBearing equals true`), and any user-authored property rule now match, in the exported SVG, the sheet SVG, the sheet PDF (which rasterizes the sheet SVG) and Print. Fire Safety's three fire-rated wall rules still do not: they compare `FireRating` numerically (`greaterOrEqual` 120, 60, 30), but `Pset_WallCommon.FireRating` is declared `IfcLabel`, so a schema-conformant file writes it as a string ('REI 120', 'EI90', or a bare '120') and the rule engine's numeric operators only ever compare two numbers. Making those three match is a change to the preset's own criteria and is tracked separately. `useDrawingExport.propertyOverride.test.tsx` pins both halves against a parsed IFC4 fixture.

The live on-screen 2D canvas (`Drawing2DCanvas.tsx`) is unchanged. Like #3520 found for `materials`, it has no data-store reference in its hot per-frame render loop, and threading one through is a larger, separate change. DXF export carries no fill or stroke color and was never affected.
