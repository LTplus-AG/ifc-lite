---
'@ifc-lite/drawing-2d': patch
'@ifc-lite/renderer': patch
'@ifc-lite/geometry': patch
---

Seven public option fields that nothing reads are now marked `@deprecated`,
with JSDoc that says what actually happens instead of what the old comment
promised. No behaviour changes and no export is removed or renamed — the
values were already ignored at runtime; only the type-level documentation
changes, so editors now warn at the point a caller sets one.

- `SVGExportOptions.units` (`drawing-2d`) — `export()` never destructures it;
  the exporter emits no dimension annotations and always sizes the sheet in
  millimetres.
- `OpeningFilterOptions.keepBoundarySegments` (`drawing-2d`) — merged into the
  filter's options object but never consulted; `tolerance` is the only field
  that governs how segments near an opening edge are treated.
- `DoorSymbolConfig.showThreshold` (`drawing-2d`) — no threshold-rendering code
  exists, so `true` and `false` produce identical geometry.
- `SnapOptions.snapRadius` (`renderer`) — documented as a world-units snap
  distance, but every proximity check reads `screenSnapRadius` (pixels).
  Snapping is screen-space and zoom-dependent; set `screenSnapRadius` instead.
- `SectionPlaneRenderOptions.flipped` (`renderer`) — the gizmo renderer never
  reads it. The GPU clip plane flips correctly through separate state, so
  cutting behaviour is unaffected; only the gizmo option is inert.
- `RenderOptions.enableDepthTest` (`renderer`) — dead on both ends: nothing
  sets it and nothing reads it. Depth comparison is fixed per pipeline at
  construction time and is not configurable through `RenderOptions`.
- `StreamingOptions.onMetadataBootstrap` (`geometry`) — an unfinished stub. Its
  siblings `onBatch`, `onColorUpdate`, `onComplete` and `onError` are all
  dispatched by the bridge; this one never is, so a callback passed here is
  never called.

Deprecating rather than deleting is deliberate: removing an optional field an
embedder already passes converts a silent no-op into a TypeScript compile
error, which is a worse first contact with the problem than a deprecation
warning that explains it. Removal is left as a separate, explicitly versioned
decision. See issue #2731 for the full audit; the findings that carry a
behaviour decision (the streaming batch ramp-up, `GeometryQuality`, and the
scale-bar / north-arrow renderer divergence) are deliberately untouched here.
