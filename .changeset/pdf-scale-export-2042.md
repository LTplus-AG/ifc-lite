---
"@ifc-lite/drawing-2d": minor
---

Add `computePdfScaleLayout`, `worldPointToPdfMm`, and `worldLengthToPdfMm`: pure scale/extent arithmetic for exporting a section drawing to a dimensionally accurate ("to scale") PDF page (#2042). The page is sized to the drawing extent at the exact chosen scale plus a margin, rather than fit into a fixed named paper size, so a selected scale (e.g. 1:100) is never silently re-scaled to make the drawing fit — unlike the existing sheet-fit transform in `sheet/sheet-types.ts`, which is correct for an on-screen preview but not for a document someone measures from.
