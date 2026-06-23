---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

GLB export: add a `lit` option (default `true`) so exported models render with
standard PBR lighting in external viewers instead of flat `KHR_materials_unlit`.
`GeometryProcessor.exportGlb(.., lit?)` and `exportGlbFromMeshes(meshes, includeMetadata?, lit?)`
now emit lit materials by default; pass `lit: false` for the previous flat,
apparent-colour look. Normals were always written — only the unlit material
extension suppressed shading. (#1321)
