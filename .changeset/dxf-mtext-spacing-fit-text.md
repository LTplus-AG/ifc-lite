---
"@ifc-lite/drawing-2d": patch
"@ifc-lite/viewer": patch
---

DXF underlay text now matches AutoCAD more closely. Multi-line MTEXT honours its line-spacing factor (group 44, default 1, clamped 0.25–4) on AutoCAD's 5/3 × height pitch, instead of a fixed 1.3 × height. TEXT set to Aligned or Fit now stretches between its two alignment points: Aligned scales height and width together, Fit stretches only along the baseline. The relative X scale (group 41) on plain TEXT is honoured too. This applies on the canvas and in SVG, PDF and DXF exports. Aligned and Fit text carries its exact span: the canvas and PDF renderers measure the real glyphs and stretch to the span (Aligned scaling both axes), and the DXF export re-emits Aligned (72=3) or Fit (72=5) with its second point so CAD readers fit it exactly. SVG cannot measure glyphs, so it uses `textLength` for the exact span while Aligned text keeps a height estimated from an average 0.6 em advance; drawing bounds use the same estimate, with extra room for narrow Aligned glyphs.
