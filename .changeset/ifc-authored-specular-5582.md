---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
"@ifc-lite/cache": minor
---

Extract IFC-authored specular finish and carry it through to the viewer (#5582). `ifc_lite_processing::style::extract_surface_style_specular` reads `IfcSurfaceStyleRendering`'s `SpecularColour` / `SpecularHighlight` / `ReflectanceMethod` and maps them to a metallic/roughness pair:

- `ReflectanceMethod` of `METAL`/`MIRROR`, or a chromatic (tinted) `SpecularColour` `IfcColourRgb` (a conductor's Fresnel is wavelength-dependent; a dielectric's is not), sets `metallic = 1.0`.
- `SpecularHighlight`, when authored, sets roughness directly: an `IfcSpecularRoughness` factor (already 0..1) is used as-is; an `IfcSpecularExponent` (Phong) converts via the standard Karis Phong-to-GGX approximation `roughness = sqrt(2 / (n + 2))`.
- Otherwise a `SpecularColour` factor (or the luminance of a `SpecularColour` `IfcColourRgb`) sets `roughness = 1 - factor` — the common case for BIM exporters, which populate this factor and nothing else.
- A non-finite authored value (malformed or overflowed STEP real) is treated as unauthored.

Verified against `AC20-FZK-Haus.ifc`: 'Glas' (`SpecularColour` 1.0) carries an authored roughness of exactly 0.0 with no metal evidence (the shader's `MIN_SPECULAR_ROUGHNESS` guard, not the extractor, keeps its highlight finite); 'Kiefer, glänzend' (glossy pine, 0.75) maps to roughness 0.25, and the plain 'Kiefer' style (factor 0.1) to 0.9.

**How it reaches the viewer, additively.** `ifc-lite-processing`'s public structs are unchanged. `prepass::resolve_geometry_finishes` builds a per-geometry-item finish index over the same styled items (and the same first-wins, same-style choice) as the colour index. Every browser prepass result carries a `styleFinishes` array beside `styleColors`. `@ifc-lite/wasm`'s new `setStyleFinishes` hands it to each instance, and the batch stamps each mesh's `metallic`/`roughness` by its `geometry_item_id`. `@ifc-lite/geometry` exposes it as `MeshData.material`, and the renderer feeds it to `packMeshMaterial` (#5386) through the new optional `Mesh.finish` / `BatchedMesh.finish` (`MeshFinish`). `Mesh.material` keeps its `Material` type, and `packMeshMaterial` prefers `finish` over a caller-supplied `Mesh.material`.

The renderer's batch colour key folds the finish in (`chunk-grid.ts`'s `colorKey`, 1/1000 resolution), so two pieces sharing a colour but authoring visibly different finishes never merge into one batch. A batch draws with a single material row.

`@ifc-lite/cache` format v22 stores each mesh's finish (NaN = absent), so a cache-restored mesh keeps its authored gloss and lands in the same batch-key bucket it was evicted from. The viewer's cache key includes the format version, so v21 entries re-parse once.

Not covered yet, tracked in #5984: server REST and Parquet transports, finishes authored only on a type's `IfcRepresentationMap`, and textured meshes.
