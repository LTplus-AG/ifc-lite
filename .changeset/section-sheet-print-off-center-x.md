---
"@ifc-lite/drawing-2d": patch
"@ifc-lite/viewer": patch
---

Fix a 'side' section's drawing sheet — preview, print and export alike — landing off-center on the sheet along X.

`calculateDrawingTransformForAxis` (added to fix the analogous Y-axis issue) only corrected `translateY` for the caller's Y-flip; `translateX` was passed through unmodified regardless of the caller's X-flip. 'side' sections flip X (`adjustedX = -x`, to view from the conventional direction) but `calculateDrawingTransform`'s `translateX` bakes in the assumption of no X-flip, so a 'side' section whose bounds weren't symmetric about X=0 was centered at a point shifted by `(minX + maxX) * scaleFactor` — up to the full width of the viewport for a section far from X=0.

`calculateDrawingTransformForAxis` now takes an optional `flipX` parameter (default `false`, preserving prior behavior for callers that don't pass it) and applies the mirror-image correction to `translateX` when it is true. Both the preview (`Drawing2DCanvas.tsx`) and the print/export path (`useDrawingExport.ts`'s `generateSheetSVG`) now pass their already-computed `flipX` through, so a 'side' section centers correctly and can no longer diverge between preview and export.
