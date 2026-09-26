---
"@ifc-lite/wasm": patch
---

Plan-rotated walls with openings now come out the same in the viewer as on the native path. The viewer stores each element's vertices relative to its own origin. In that frame, three checks read the vertices at their stored precision: the analytic opening cut's closure check, the wall-frame closure check, and the snap tolerance. So the same wall could be cut differently and left open, with 61 to 105 open edges on a 13-window test wall at 17° to 133°. Now a rotated wall's analytic cut is kept only if it is closed as it will be emitted. If it is not, the same cut is made in the wall's own frame, and that result is kept when it is closed and has fewer defects. The wall-frame cut is also judged as it will be emitted: rotated back, with degenerate slivers removed. The snap tolerance now comes from world coordinates.
