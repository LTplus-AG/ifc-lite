---
"@ifc-lite/viewer": patch
---

Fix the 2D sheet drawing rendering at the wrong position/scale after swapping paper size, scale, or a saved sheet template while "keep position on regenerate" (pinned) was on.

`Drawing2DCanvas` reuses `cachedSheetTransformRef.current` whenever pinned, instead of recomputing the transform from the active sheet's viewport/scale/paper. `useViewControls` only cleared that cache on an axis/flip change or a `sheetEnabled` on/off toggle — but `setPaperSize`, `setFrameStyle`, `updateFrameMargins`, and `setDrawingScale` all mutate the same sheet in place (same id), and `loadTemplate` swaps in a different sheet entirely, none of which ever touch `sheetEnabled`. The cache kept the OLD sheet's transform applied to the new paper/scale/viewport until the user toggled sheet mode off and back on, or changed the section axis.

`useViewControls` now also invalidates the cache whenever the sheet's id, paper size, viewport bounds, or scale factor changes.
