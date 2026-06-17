---
"@ifc-lite/geometry": patch
"@ifc-lite/drawing-2d": patch
"@ifc-lite/renderer": patch
---

Restore per-layer slicing of single-solid walls/slabs with an `IfcMaterialLayerSetUsage`. Slicing turns one solid into one coloured sub-mesh per material layer (geometry_id = the layer's `IfcMaterial`) so the build-up is visible in 3D.

The slicing kernel stayed intact, but #874 (mesh-production unification) dropped the `set_material_layer_index` wiring from every pipeline, so the router's index was always `None` and `try_layered_sub_meshes` never fired — layered walls silently rendered as a plain single solid in the browser, native, and server paths. Re-wire it: build the `MaterialLayerIndex` once per load (cached on the IfcAPI for the streaming path, with a cheap substring bail-out so files with no layer set pay nothing) and attach it to every batch router. This also restores the "Merge Multilayer Walls" toggle for models whose sliceable walls carry their geometry as `IfcBuildingElementPart`s — the merged parent now actually draws its sliced solid instead of leaving a gap.

2D section now shows the layers too. The section cutter carries each sub-mesh's colour onto its cut segments (CPU and GPU paths), and the polygon builder splits one entity's cut into a polygon per material colour — single-material elements still produce one colourless polygon, so their existing per-`ifcType` / per-entity fill is unchanged. When the viewer shows IFC materials, each sliced layer fills with its own `IfcMaterial` colour instead of one colour for the whole wall, and the layer divisions are drawn as outlines — matching the 3D build-up.

Two follow-on robustness fixes:

- **3D layer glitch (z-fighting).** Adjacent layer slabs share the parent wall's `expressId`, so the renderer's per-entity depth nudge (keyed on `entityId`) gave their coincident interior interface caps the SAME depth — under `cullMode: 'none'` + MSAA that z-fought into a flickering comb that read as "see inside / not solid". The shader now folds the per-draw `baseColor` into the depth-nudge hash; batches are keyed by colour, so abutting layers (distinct colours) land on distinct depths. Constant per draw, so flat faces stay flat and curved surfaces are unaffected.

- **Cap watertightness on irregular profiles.** A layer slab's innermost cut is built by two successive plane clips; on a non-convex `IfcArbitraryClosedProfileDef` the two passes deposit geometrically-coincident section vertices that differ by ~1 ULP. `cap_half_space_clip` welded by exact f32 bits, so those twins stayed separate, the boundary chain dead-ended and a cap sub-loop was silently dropped — leaving open edges (a hole you could see through and a section with no fill there). The cap now welds on a spatial grid tied to its on-plane tolerance, collapsing the twins so the loop closes. Single-plane callers (opening cuts) have no such twins and are unaffected.
