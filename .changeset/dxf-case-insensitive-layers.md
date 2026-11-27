---
"@ifc-lite/drawing-2d": patch
---

Fix DXF export merging layers whose names differ only by case. DXF symbol names are case-insensitive, so `Walls`, `walls` and `WALLS` were written as three LAYER records that CAD readers collapse into one, silently dropping the other layers' colour and linetype. The writer now disambiguates layer names case-insensitively (the existing numeric suffix) and keeps `Defpoints`, AutoCAD's non-plotting layer, out of user layers.
