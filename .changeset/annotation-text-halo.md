---
"@ifc-lite/renderer": patch
---

IfcAnnotation labels now draw with a thin contrasting halo (black around light text, white around dark text), so they stay legible over model geometry and over the empty backdrop in every theme (#5388). Glyph quads and atlas UVs are widened by the halo margin; the glyph itself does not move.
