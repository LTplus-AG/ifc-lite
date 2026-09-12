---
"@ifc-lite/wasm": patch
---

Restore stable mixed-opening geometry when multiple planar footprints are followed by residual 3D cuts. Public and pure 2D subtraction retain correct union semantics; only mixed residual composition temporarily uses its prior parity behavior because the unioned intermediate could turn an established small seam into hundreds of open edges.
