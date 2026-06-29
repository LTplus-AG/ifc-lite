---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

Fix GLB export collapse on georeferenced models with rotated instanced occurrences.

The GPU-instancing collator built each occurrence's relative transform as
`rel = m_k · m_ref⁻¹` on the **pre-RTC** (absolute, georeferenced-magnitude)
placements stored in `InstanceMeta.transform`, while the baked template `origin`
is **post-RTC** (small). For an occurrence rotated relative to its template,
`rel.translation = T_k − R_rel·T_ref` — and when the rotation flips an axis the
two ~1e6 m terms *add* instead of cancel, reaching **2× the georeference**. The
renderer then applies that to the small template origin, so those occurrences fly
out to twice the site offset. On a georeferenced model (e.g. EPSG:4326 rebar) this
dragged the GLB exporter's scene-center to ~6e6 m and re-snapped every f32 vertex
to a ~0.5 m grid, collapsing the whole model on export / re-import.

`collate_refs` now takes the applied RTC and reduces both composed transforms to
the post-RTC frame before forming the relative transform, so the offset cancels
exactly regardless of rotation and the relative translation stays at building
scale (consistent with the small template origin the renderer applies it to). The
`processGeometryBatchInstanced` shard path passes the real RTC; the from-bytes
glTF exporter passes `[0,0,0]` because it already conjugates by RTC per occurrence
downstream. Non-georeferenced models (RTC `[0,0,0]`) are unchanged.

Verified end to end: instanced occurrences for a georeferenced model now stay at
building scale (was ~1.2e7 m), the viewer GLB export is precise (±9 m, was ±6e6 m
collapsed), and the export → re-import round-trip is geometrically intact.
