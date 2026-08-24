---
"@ifc-lite/wasm": patch
"@ifc-lite/viewer": patch
---

Put the symbolic annotation/grid overlay in the same coordinate frame as the meshes it is drawn over.

The symbolic extractor re-based its plan coordinates by the wrong component of the model RTC offset — the offset's Z (elevation) was subtracted along the northing axis — and never re-based the elevation it reports as `worldY` at all. Both mistakes are invisible for a model near the origin, where the offset is (0,0,0), and neither had test cover. For a georeferenced model the mesh pipeline re-bases every vertex by the whole offset, so annotations, dimension text, fill areas and grid bubbles were drawn a northing away from the building, at an elevation that no longer matched any storey; the plan view's grid section-clip compared that unshifted elevation against a re-based cut band, so the visible grid belonged to the wrong storey or to none.

The offset now travels as one `RenderFrameRebase` with private components and two named conversions (`plan`, `elevation`) instead of two loose floats threaded through six modules, so no call site can reach for the wrong axis. The viewer half matches: the storey-table elevation that `buildParseResult` falls back to when a placement carries no Z is re-based to the same frame as the extractor's `worldY`, since both feed one set of buckets lifted into one scene.
