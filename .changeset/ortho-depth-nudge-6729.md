---
"@ifc-lite/renderer": patch
---

Orthographic views no longer draw hidden surfaces in front of visible ones. The per-entity anti z-fighting depth nudge scaled with depth across the whole scene range, shifting surfaces by tens of centimetres on large sites; in orthographic projection it is now a fixed few depth-buffer units at every depth. Perspective rendering is unchanged.
