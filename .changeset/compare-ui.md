---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": minor
---

Model comparison in the viewer (#924). A new **Compare** panel (Analysis menu)
lets you pick two loaded models as version A/B, run a comparison, and review
**added / changed / deleted** elements — colour-coded in 3D (green / yellow /
red, with unchanged ghosted or hidden) and listed in the panel; clicking a row
selects and frames the element. A **data / geometry / both** scope toggle
switches what counts as a change.

`@ifc-lite/geometry` now surfaces the WASM mesh pass's RTC-invariant per-entity
geometry fingerprint: `GeometryProcessor.enableGeometryHashes()` turns it on and
each `MeshData.geometryHash` carries the hash (threaded through the streaming +
parallel worker paths). This feeds the geometry side of the diff: a moved or
reshaped element reads as a geometry change, while the global georeferencing
offset (RTC) does not — the hash is RTC-invariant.
