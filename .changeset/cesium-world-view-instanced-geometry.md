---
"@ifc-lite/viewer": patch
---

3D World Context now shows the whole model — repeated geometry (curtain-wall facades, mullions, windows) no longer disappears on the map.

The Cesium overlay built its GLB from `geometryResult.meshes`, which by design holds only part of the model: GPU-instanced occurrences render from compact shards and are deliberately absent from that flat list, as `utils/instancedExport.ts` documents and as the glTF and IFC exporters already compensate for. The world view never did, so every repeated occurrence was dropped from the map while the WebGPU viewport drew it correctly. On the model from issue #2558 that was 9,950 of 18,555 meshes and 396K of 655K triangles — a tower's entire facade gone, leaving bare floor slabs over Google's imagery.

Building the GLB and its cache key now live together in `lib/geo/cesium-model-glb.ts`, which materialises the instanced half through the same `withInstancedMeshes` helper the exporters use. The cache key also counts instanced entities rather than flat meshes alone, so a geometry batch whose occurrences are all instanced — one that adds no flat meshes at all — no longer reads as "unchanged" and serve a stale model.
