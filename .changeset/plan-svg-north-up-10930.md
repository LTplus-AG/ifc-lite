---
"@ifc-lite/drawing-2d": patch
---

`exportToSVG` draws cardinal floor plans north-up. It flipped paper Y for every view, but a plan cut projects render Z, which already points south, so plans came out mirrored with north at the bottom. Vertical sections and custom-plane cuts still flip, so model up stays at the top of the sheet.
