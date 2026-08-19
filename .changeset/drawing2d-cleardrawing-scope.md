---
'@ifc-lite/viewer': patch
---

Fix `clearDrawing2D` wiping graphic overrides, DXF underlays, and all 2D
annotations instead of just the generated drawing.

`clearDrawing2D` called `set(getDefaultState())`, resetting the entire
`Drawing2DSlice` to its initial values. The "View 2D" button
(`SectionPanel.tsx`) calls it solely to force drawing regeneration with the
current settings -- but the whole-state reset also discarded the user's
custom graphic-override rules, the enabled/disabled state of the built-in
overrides, every DXF underlay they had imported, and every measurement,
polygon-area, text, and cloud annotation on the 2D sheet.

`clearDrawing2D` now resets only the drawing-generation fields
(`drawing2D`, `drawing2DStatus`, `drawing2DProgress`, `drawing2DPhase`,
`drawing2DError`, `drawing2DSvgContent`).
