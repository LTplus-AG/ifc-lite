---
"@ifc-lite/renderer": minor
---

The geometry shader now has a default specular term (#5386): a GGX/Smith/Schlick-Fresnel lobe for the sun plus a split-sum environment reflection along the reflection vector, using the `metallicRoughness` uniform the renderer already wrote but the shader never read. Diffuse is weighted down by `(1 - Fresnel) * (1 - metallic)` so a highlight never adds energy on top of full diffuse.

This replaces the old fake glass branch (a fixed tint mix, a flat `glassShine` term, edge desaturation, and a flat 0.7 alpha multiply applied to every translucent material regardless of its actual finish). Glass is now derived from the AUTHORED alpha a mesh was drawn with — not any display fade (X-Ray, compare) applied on top — so a faded opaque wall stays a dielectric and only real translucent geometry reflects as glass, with a roughness low enough to show a sky reflection and a sun glint.

`mesh-material.ts`'s `packMeshMaterial` is the single writer of the mesh uniform's material row across every draw path (flat, batched, textured, instanced template), replacing repeated `mesh.material?.roughness ?? 0.6` literals. The default opaque roughness moved from 0.6 to 0.9 (`DEFAULT_MATERIAL_ROUGHNESS`): at 0.6 the new specular term's highlight washed a whitish film over sunlit coloured roofs; at 0.9 it is a faint, broad sheen that leaves a plain white/grey wall visually unchanged (pinned in `mesh-material.test.ts` and verified with pixel samples before/after this change: a sampled FZK-Haus wall moved by at most 1/255 per channel).

No IFC-authored specular (`IfcSurfaceStyleRendering`'s `SpecularColour`/`SpecularHighlight`/`ReflectanceMethod`) is extracted yet — every draw uses this default unless its `Mesh.material` already supplies metallic/roughness. That extraction is filed separately as #5582.
