---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

X-Ray now reaches 3D World Context, and glass on the map looks like glass.

The world view drew every element fully opaque no matter its alpha. Clash focus in ghost mode, the Space Sketch preview and layer diff all faded the model in the viewport and changed nothing on the map; authored `IfcSurfaceStyleRendering` transparency was ignored there too. The cause was one line that was never written: a glTF material with no `alphaMode` is `OPAQUE` per spec, so Cesium discarded the per-vertex alpha the exporter had been packing all along.

The merged GLB now emits up to two primitives over the same vertex buffers — one opaque, one `alphaMode: 'BLEND'` — split by mesh alpha. Splitting rather than blending the whole model keeps the bulk of the geometry out of the translucent pass, where triangles are not depth-sorted against each other. A model with no translucent geometry still emits exactly one primitive, as before.

`@ifc-lite/renderer` exports `DEFAULT_GHOST_ALPHA` and `OPAQUE_ALPHA_CUTOFF` so the world view matches the viewport's ghosting rather than inventing its own; the ghost alpha was previously a literal inside `Renderer.render`. Selection is exempt from ghosting on the map exactly as it is in the viewport, and the GLB cache key carries a content-based ghost epoch so an equal set does not rebuild.

One deliberate difference: GPU-instanced occurrences ghost on the map but not in the viewport, because the renderer's instanced pass never receives the ghost set. That is the viewport being wrong, and replicating it to stay symmetrical would have meant copying a defect.
