---
"@ifc-lite/drawing-2d": major
---

Hidden-line removal now actually occludes (issue #2639). The occluder depth buffer previously rasterized the cut-away half-space, and projection lines carried depth 0 or a negative flip-adjusted depth, so classification degenerated to "everything visible" - or, when no occluder vertex fell in the window and no bounds were passed, to "everything hidden" via NaN buffer indexing. The classifier now rasterizes the kept half of the section, and both the buffer and line depths carry the VIEW DEPTH convention: the negated flip-adjusted signed depth, 0 at the cut plane, increasing into the kept half, smaller means nearer the viewer.

Breaking changes:

- `HiddenLineClassifier.buildDepthBuffer(meshes, axis, position, maxDepth, flipped, bounds?)` is now `buildDepthBuffer(meshes, plane, occluderDepth, bounds?)`, taking the full `SectionPlaneConfig`. It honours `plane.customPlane`, so custom (face-picked) planes classify in their own basis instead of silently falling back to the stale cardinal fields.
- `DrawingLine.depth` semantics change to view depth at the line's start point. A new optional `DrawingLine.depthEnd` carries the view depth at the end point; the classifier interpolates between the two along the line.
- Drawings will show more dashed/hidden projection lines than before, because the previous output never hid correctly occluded geometry.
- Line samples falling outside the depth raster's 2D bounds now classify VISIBLE instead of clamping onto the nearest border pixel. Outside the raster there is no occluder information, so visible is the only safe default; the old clamping could wrongly hide a line far from any occluder when `buildDepthBuffer` was called without a `bounds` argument and the self-computed bounds (in-window vertices only) collapsed to a sliver of a straddling occluder.
- `mergeDrawingLines` now derives each merged line's `depth`/`depthEnd` from the source segment endpoints that became the merged endpoints (swapping them when a source segment runs against the merge direction), instead of copying the first source line's pair onto the whole merged run - a copy that was only lossless while every projection line carried depth 0.
