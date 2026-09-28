---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
"@ifc-lite/cache": minor
---

The IFC-authored specular finish (#5582) now reaches instanced and textured meshes, and finishes authored at type level (#5984).

- **Instanced (IFNS) shard.** Trailing field 2, `[metallic, roughness]` (f32, NaN = unauthored), written as shard v3 (stride 100) only when an occurrence in the shard authors a finish. Every other shard stays byte-identical. Older decoders already skip unknown trailing fields, and `@ifc-lite/geometry`'s decoder exposes the new field as `DecodedInstance.metallic` / `.roughness` (plus `carriesFinishes`). The renderer packs each occurrence's finish into spare bits of its instance flags lane, so the instanced record, vertex layout, picker and shadow passes are unchanged. On `AC20-FZK-Haus.ifc` this covers the 42 instanced `IfcMember` 'Kiefer' pieces (roughness 0.9).
- **Textured meshes** take `MeshData.material` as `TexturedMesh.finish`, which the textured draw prefers.
- **Type-level finishes.** The wasm batch now joins finishes through `ifc_lite_processing::style::MeshFinishJoin`, so a mesh takes the finish of the style its colour came from. That includes #957 type geometry and occurrences styled on their `IfcMappedItem`.
- `@ifc-lite/cache` `FORMAT_VERSION` 22 → 23, so entries cached without these finishes re-parse once.
