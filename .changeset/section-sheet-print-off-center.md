---
"@ifc-lite/drawing-2d": minor
---

Fix a 2D-Section drawing sheet's print/export showing the drawing at a different, wrongly-centered position than the on-screen preview.

`calculateDrawingTransform` always derives `translateY` assuming the caller flips Y when mapping model coordinates onto the paper (matching cardinal axes other than plan/'down'). The sheet preview (`Drawing2DCanvas.tsx` in `@ifc-lite/viewer`) already corrected `translateY` for plan sections, which don't flip Y, but the print/export path (`generateSheetSVG` in the same app) reused the raw, always-flipped transform — for a plan section whose bounds weren't symmetric about Y=0, the printed sheet centered the drawing at a different point than the preview, or pushed it outside the viewport's clip entirely.

Added `calculateDrawingTransformForAxis(drawingBounds, viewportBounds, scale, flipY)`, which wraps `calculateDrawingTransform` and applies the flip correction for a caller-supplied `flipY`. Both the preview and the print/export path now call this one function with the same `flipY`, so they can no longer diverge.
