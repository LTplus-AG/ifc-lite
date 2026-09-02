---
'@ifc-lite/cache': patch
---

Fixed the GLB reader (`resolveMaterialColor` in `parseGLBToMeshData`) copying `pbrMetallicRoughness.baseColorFactor` straight into `MeshData.color`. `baseColorFactor` is defined in LINEAR colour space (glTF 2.0 spec), while the mesh-colour pipeline the viewer consumes is sRGB — so after the exporter fix that emits linear factors, the reader treated those linear values as sRGB on an export → re-import round-trip and rendered too dark, and any spec-conformant external GLB was mis-read the same way. The reader now applies the inverse IEC 61966-2-1 encode (linear → sRGB) to the R/G/B channels only, clamped to [0, 1]; alpha passes through untouched. This is the reader half of the writer fix in `@ifc-lite/wasm`.
