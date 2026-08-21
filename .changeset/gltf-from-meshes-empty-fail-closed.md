---
'@ifc-lite/wasm': patch
'@ifc-lite/geometry': patch
---

Fix: `exportGlbFromMeshes` (the viewer's from-meshes GLB path, e.g. exporting
the current selection) now fails closed with `NO_RENDER_GEOMETRY` when the
visible mesh set is empty, instead of returning a "successful" GLB.

That GLB was structurally invalid per the glTF 2.0 schema: `accessors`,
`bufferViews`, `meshes` and `nodes` were emitted as empty arrays (the schema
requires `minItems: 1` on each when present) and the single buffer's
`byteLength` was `0` (schema `minimum: 1`) — confirmed against the reference
`gltf-validator`. A consumer that enforces the schema (many glTF tools do)
rejected the file outright.

`exportGlb` (the from-bytes path) already guarded this case
(`NO_RENDER_GEOMETRY`, #1438/#1516); `exportGlbFromMeshes` was the one
sibling entry point that did not, and it is reachable directly from the
viewer whenever a caller's filtered mesh list — or a filtered list where
every mesh fails the minimum-geometry check (fewer than 3 vertices, or no
indices) — comes back empty.
