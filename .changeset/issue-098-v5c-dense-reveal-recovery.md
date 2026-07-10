---
"@ifc-lite/wasm": patch
---

Repair the residual void-cut tearing on the densest faceted-BREP splayed-reveal walls (ara3d ISSUE_098 Poroton Ventilata, wall `3FceP9AqX1_92g5eDdrV5C`). Where many windows batch onto one wall face, the incremental channel recovery leaves a few constraints unforced (a self-touching "figure-8" channel the boundary walk can't traverse), which rejected the whole batched cut to the sequential re-jitter path and re-fragmented the wall.

Two kernel additions: (1) a robust Sloan ordered-traversal fallback (`recover_via_traversal`) that forces those constraints by walking the crossed triangles in segment order, immune to the pinch; and (2) a volume-safe batched-difference accept (`subtract_many`) that keeps the exact (cleaner) batched cut when its removed volume matches a sequential reference, and only falls back to sequential when it would over/under-cut. The dense wall drops from ~2072 to ~108 open edges with its removed volume unchanged; the #1167 rotated-wall under-cut and the full CSG corpus stay green.
