---
"@ifc-lite/cache": patch
---

GLB export/import placement fixes.

The GLB importer (`parseGLBToMeshData` / `loadGLBToMeshData`) now composes node-
hierarchy translation into world vertex positions. The Rust exporter places all
element geometry under a single translated root node (vertices stored relative to
one scene centre for f32 precision); a parser that read accessors alone landed the
whole model at that centre ("all centre aligned"). It now walks the scene roots,
accumulates translation, and bakes it into each mesh node's vertices so re-imported
GLBs — and any GLB with node transforms — land at their true world position.

Paired with the Rust `ifc-lite-export` GLB/OBJ fixes (self-contained, scene-centre-
baked geometry + IFC Z-up→WebGL Y-up conversion on the from-bytes path + double-
sided materials).
