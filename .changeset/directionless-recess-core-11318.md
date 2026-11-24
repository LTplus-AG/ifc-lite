---
"@ifc-lite/wasm": patch
---

Keep the wall intact when a tessellated recess that touches the core but encloses only air falls back to the box cut. The box fallback now runs the air-only check for openings without an extrusion direction too, so it no longer clips the core face and leaves open edges.
