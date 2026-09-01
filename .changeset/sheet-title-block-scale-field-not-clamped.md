---
'@ifc-lite/viewer': patch
---

Fix a Drawing Sheet's title block printing the requested scale ratio instead of the actual one when the viewport fit shrinks the drawing.

`sheet-types.ts`'s `calculateDrawingTransform` (`fitScale = min(scaleX, scaleY, 1)`) can shrink a drawing below its requested named scale to fit the sheet's fixed viewport. The scale bar already accounted for this — `generateSheetSVG` passes the actual `scaleFactor` to `renderTitleBlock` as `effectiveScaleFactor` — but the title block's "Scale" text field is plain static content, written once (by `sheetSlice.ts`'s `autoPopulateTitleBlock`) from the requested `sheet.scale.factor`, and was never corrected the same way. A sheet whose drawing had to be shrunk to fit the page could print e.g. "Scale: 1:100" next to a bar and a drawing both actually rendered at a materially different ratio — a silently wrong deliverable, the same defect class PR #2131 fixed for the plain (non-sheet) SVG exporter's title block.

`generateSheetSVG` (`useDrawingExport.ts`) now runs the title block through `titleBlockWithEffectiveScale` (new `apps/viewer/src/hooks/titleBlockScaleField.ts`), which replaces the "scale" field's value with the actual rendered ratio whenever the fit clamp changed it, and leaves the title block untouched otherwise.
