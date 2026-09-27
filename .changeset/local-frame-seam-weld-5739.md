---
"@ifc-lite/wasm": patch
---

Plan-rotated walls with openings that still kept hairline seams in the viewer now come out closed. The viewer stores each element's vertices relative to its own origin. The analytic opening cut sized its vertex weld from those small stored coordinates, so vertices a few micrometres apart stayed unmerged and left T-junction seams, where the native path produced a closed wall. When such a cut is accepted but still open, it is now re-welded at the world-coordinate precision and its T-junctions are split. The result is kept only if it becomes strictly closed with its volume unchanged. Native output is unchanged.
