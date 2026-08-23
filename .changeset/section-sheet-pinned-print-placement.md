---
"@ifc-lite/viewer": patch
---

Fix a 2D-Section drawing sheet printing at a different position than the preview while Pin View is on.

Pin View (on by default) holds the sheet placement steady while the drawing's bounds change underneath it — that is what pinning is for. The preview honoured it by reusing a cached transform; the print/export path (`useDrawingExport`'s `generateSheetSVG`) was never given the pin state or the cache at all, so it re-fitted the drawing from the current bounds. The cache is deliberately keyed on the sheet's geometry (id, paper, viewport, scale) and not on the drawing bounds, so it stayed valid across a regenerate at a new elevation: the preview kept the held placement and the print computed a different one. Same visible symptom as the earlier off-centre print, different cause.

Both paths now go through one resolver (`resolveSheetTransform`) that owns the per-axis flip correction and the cache read, with the flips derived from the section axis rather than at each call site. The preview still owns the cache write, and the export path never writes, so printing cannot move what is on screen.
