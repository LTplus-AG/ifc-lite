---
'@ifc-lite/export': patch
'@ifc-lite/data': minor
---

Fixed `@ifc-lite/export`'s own GLB reader (`parseGLBToMeshData`, published from the package root and shown in the exporting guide) copying `pbrMetallicRoughness.baseColorFactor` straight into `MeshData.color`, the same defect just fixed in `@ifc-lite/cache`'s GLB reader. `baseColorFactor` is defined in LINEAR colour space (glTF 2.0 spec), while the mesh-colour pipeline is sRGB — after the exporter fix that emits linear factors, this reader (unlike `@ifc-lite/cache`'s) still read them as sRGB and rendered a re-imported mesh about 2.3x too dark. It now applies the same inverse IEC 61966-2-1 encode (linear → sRGB) to the R/G/B channels only, clamped to [0, 1]; alpha passes through untouched.

The linear→sRGB conversion (`linearToSrgb`) moved to `@ifc-lite/data` — a package both `@ifc-lite/cache` and `@ifc-lite/export` already depend on — so the two GLB readers share one implementation instead of drifting again.
