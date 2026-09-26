---
"@ifc-lite/wasm": patch
---

Plan-rotated walls with openings take the same cut route in the viewer as on the native path. The viewer stores each element's vertices relative to its own origin, and the analytic opening cut's decisions read the vertices at that stored precision. So the same wall could pass them in the viewer, keep seams, and come out open. The cut now decides on the wall's world coordinates. The wall-frame cut is judged rotated back and after degenerate-sliver cleanup, and its snap tolerance comes from world coordinates.
