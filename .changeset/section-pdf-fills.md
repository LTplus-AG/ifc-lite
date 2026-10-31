---
"@ifc-lite/viewer": patch
---

The scaled section PDF now fills cut elements with the same colours as the screen and the SVG export (IFC type colours, 3D material colours including per-layer colours, or graphic overrides) and uses override stroke colours and line weights. It used to draw black outlines only. Override colours the PDF cannot use (an unfinished hex value, a named colour) fall back to the type colour or black for that element instead of breaking the export. Both SVG exports now also use per-layer material colours, and no export fills the opening of a cut whose outer ring could not be rebuilt.
