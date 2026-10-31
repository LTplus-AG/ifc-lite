---
"@ifc-lite/viewer": patch
---

The scaled section PDF now fills cut elements with the same colours as the screen and the SVG export (IFC type colours, 3D material colours including per-layer colours, or graphic overrides) and takes outline colour and weight from the same settings. It used to draw black 0.5 mm outlines only; with default settings (graphic overrides on) outlines are now 0.25 mm, as in the non-sheet SVG export. Override colours the PDF cannot use (an unfinished hex value, an invalid name) fall back to the type colour or black for that element instead of breaking the export. A cut polygon whose outline cannot stand in for the element (an outer ring with no area, or a ring of two or more points the PDF cannot draw, such as non-finite coordinates) is not filled, its remaining rings are outlined, and the element's cut lines are kept. Both SVG exports now also use per-layer material colours.
