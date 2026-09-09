# Captured GLB ingest evidence (#4380)

The offline `tools/texture-authoring/derive-boulder-glb.mjs` packages the public
[Poly Haven boulder_01](https://polyhaven.com/a/boulder_01) glTF/BIN/diffuse JPEG
as a GLB. Poly Haven assets are CC0. The derivation **explicitly removes normal
and metallic/roughness maps**, producing an albedo-only fixture; the production
importer refuses those unsupported maps on the original full material.
Geometry, indexed UV seams, and diffuse JPEG bytes are unchanged.

Source glTF download:
`https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/boulder_01/boulder_01_1k.gltf`

Recorded hashes:

- Source glTF: `51487934db898b4c24072780a451e34eca5c02e3ada24a62bbc600bbc4019e92`
- Source BIN: `7f5b06503d62bd95bfe9c6b8a354a5cc8ff04a4d271a8cf87a3e3125db4232d7`
- Diffuse JPEG: `c38f0e918f6dc16b8d386ba3cdd89805c78320c119a1ceec85856f82b09a65b8`
- Derived GLB: `b6a0b51894427c37505632f4d4513d0424f0d84b014554755aa53eb74af6dcd6`

An actual run through the built cache decoder retained 67,042 vertices,
66,122 triangles, 67,042 UV pairs, and the exact diffuse JPEG digest above.
The sampler defaults to repeat in both directions; it is not silently clamped
to satisfy a downstream authoring limitation.

Automated invariants include an asymmetric seam, texture transform, rotated
nonuniform node scale, inverse-transpose normals, mirrored winding, a 12,000-node
scene chain, and explicit rejection of unsupported appearance or image ranges.
This is ingest evidence; it does not establish IFC creation, portable export,
shared-room behavior, or scan reconstruction acceptance.
