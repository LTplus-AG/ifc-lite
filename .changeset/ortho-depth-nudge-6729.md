---
"@ifc-lite/renderer": patch
---

Orthographic views draw far fewer hidden surfaces in front of visible ones. The per-entity anti-z-fighting depth nudge scaled with depth across the whole scene range, shifting surfaces by tens of centimetres on large sites; in orthographic projection it is now a fixed few depth-buffer units at every depth (at most about 6e-5 of the scene's depth range, so surfaces a few centimetres apart can still swap on kilometre-scale sites), and annotation lines and text are lifted just above it. Perspective rendering is unchanged.
