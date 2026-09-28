---
"@ifc-lite/renderer": patch
---

The main mesh shader no longer darkens edges itself (#5746). It used screen-space derivatives over a 2x2 pixel quad, so it broke into dashes along entity seams, and with the edge pass (#5385) on it darkened every crease a second time. The edge pass, controlled by `visualEnhancement.separationLines`, is now the only source of edges. `visualEnhancement.edgeContrast` is still accepted, so existing settings keep type-checking, but it has no effect. The uniform layout is unchanged: the two flag lanes it used are now always written as 0.
