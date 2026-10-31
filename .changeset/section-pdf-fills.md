---
"@ifc-lite/viewer": patch
---

The scaled section PDF now fills cut elements with the same colours as the screen and the SVG export (IFC type colours, 3D material colours including per-layer colours, or graphic overrides) and takes outline colour and weight from the same settings. It used to draw black 0.5 mm outlines only; with default settings (graphic overrides on) outlines are now 0.25 mm, as in the non-sheet SVG export. Override colours the PDF cannot use (an unfinished hex value, a colour name) fall back to the type colour or black for that element instead of breaking the export. Both SVG exports now also use per-layer material colours.
