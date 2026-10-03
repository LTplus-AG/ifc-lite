---
"@ifc-lite/renderer": patch
---

Orthographic views no longer draw surfaces more than 2.5 cm behind a face in front of it. The per-entity anti-z-fighting depth nudge scaled with depth across the whole scene range, moving surfaces by decimetres on large sites. In orthographic projection it is now bounded to 2.5 cm and never moves a vertex across the near or far plane, and annotation lines and text are lifted above it. On kilometre-scale sites a few coplanar faces whose entities rank close together can swap at grazing angles; ordinary sites rank coplanar faces as before. Perspective rendering is unchanged.
