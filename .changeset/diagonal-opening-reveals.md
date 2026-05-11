---
"@ifc-lite/wasm": patch
---

Fix diagonal and roof-window opening cuts. Oblique multilayer wall parts keep
their opening soffits within the actual wall geometry, BRep roof openings
preserve their full sloped opening frame instead of falling back to world axes,
and roof windows on shallow-slope roofs are no longer routed through unstable
full CSG by a too-aggressive "vertical extrusion ⇒ floor opening" heuristic —
classification is now per-item based on whether the opening mesh is actually a
clean rectangular box.
