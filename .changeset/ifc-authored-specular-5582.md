---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
"@ifc-lite/server-client": minor
---

Extract IFC-authored specular finish and carry it through to the viewer (#5582). `ifc_lite_processing::style::extract_surface_style_specular` reads `IfcSurfaceStyleRendering`'s `SpecularColour` / `SpecularHighlight` / `ReflectanceMethod` and maps them to a metallic/roughness pair:

- `ReflectanceMethod` of `METAL`/`MIRROR`, or a chromatic (tinted) `SpecularColour` `IfcColourRgb` (a conductor's Fresnel is wavelength-dependent; a dielectric's is not), sets `metallic = 1.0`.
- `SpecularHighlight`, when authored, sets roughness directly: an `IfcSpecularRoughness` factor (already 0..1) is used as-is; an `IfcSpecularExponent` (Phong) converts via the standard Karis Phong-to-GGX approximation `roughness = sqrt(2 / (n + 2))`.
- Otherwise a `SpecularColour` factor (or the luminance of a `SpecularColour` `IfcColourRgb`) sets `roughness = 1 - factor` — the common case for BIM exporters, which populate this factor and nothing else.

Verified against `AC20-FZK-Haus.ifc`: 'Glas' (`SpecularColour` 1.0) carries an authored roughness of exactly 0.0 with no metal evidence (the shader's `MIN_SPECULAR_ROUGHNESS` guard, not the extractor, keeps its highlight finite); 'Kiefer, glänzend' (glossy pine, 0.75) maps to a moderately glossy dielectric, distinctly less glossy than glass and distinctly glossier than the plain 'Kiefer' style (factor 0.1) in the same file.

The pair threads through `MeshData.metallic`/`.roughness` (`ifc_lite_processing`), the wasm `MeshDataJs.metallic`/`.roughness` getters, `@ifc-lite/geometry`'s `MeshData.material` (and, over REST, `@ifc-lite/server-client`'s `MeshData.metallic`/`.roughness`, converted by the viewer's `convertServerMesh`), and into the renderer's existing `packMeshMaterial` (#5386) via `Mesh.material` / `BatchedMesh.material`. The renderer's batch colour key now folds `metallic`/`roughness` in (`chunk-grid.ts`'s `colorKey`) at 1/1000 resolution, so two pieces sharing a colour but authoring visibly different finishes never merge into one batch — a batch draws with a single material row, so a mixed bucket would paint every piece with whichever finish happened to be first.

`Mesh.material` / `BatchedMesh.material` narrow from `Material` to `Partial<Material>`, since neither ever carried a per-mesh `baseColor` and the new producer only ever supplies `metallic`/`roughness`.
