---
"@ifc-lite/viewer-core": patch
---

Fix `ifc-lite view` rendering most elements collapsed near the world origin instead of at their real placement (#2261). wasm's mesh geometry is stored in a per-element local frame by default (world position = `mesh.origin` + `position`, added to keep f32 vertex storage precise at building/georef scale); the standalone CLI viewer's minimal WebGL renderer read `positions` directly without folding `origin` back in, so every element rendered near its own local frame instead of its true world placement. The main web viewer (`@ifc-lite/geometry` / `@ifc-lite/renderer`) already applied this fold and was unaffected.
