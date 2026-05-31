---
"@ifc-lite/viewer": patch
"@ifc-lite/wasm": patch
---

Fix model federation: two models now load co-located at the correct scale
instead of one being flung ~20 km away, dwarfed, or hanging on "Processing
geometry".

**Federation alignment (the regression).** When a model has no
`IfcMapConversion` we synthesise a `source: 'siteLocation'` georeference from its
`IfcSite` `RefLatitude`/`RefLongitude`/`RefElevation` so it can still be pinned on
the location map. Since #658 the federated add-model path treated that synthetic
georef as real and ran it through the projected-CRS affine alignment — but its
coordinates are geographic degrees plus a raw, un-unit-scaled site elevation, not
projected metres. For the BIMcollab ARC/STR sample (which share a site GUID but
carry `RefElevation` `0` vs `20000` mm) the height term placed the architectural
model ~20 km below the structural one. Federation alignment now requires *true*
georeferencing (`IfcMapConversion` + `IfcProjectedCRS`, via
`hasStandardGeoreferencing`); site-location-only models stay in their own local
frames where they already overlay correctly.

**Unit scale.** The streaming geometry pre-pass (`buildPrePassStreaming`)
resolved `unitScale` from a *partial* entity index — only the rows up to the
first `IFCPROJECT`. Many real exports (Revit) place `IFCPROJECT` and its
`IFCUNITASSIGNMENT` *after* the bulk of the geometry, so the assigned
`IFCSIUNIT` wasn't indexed yet, `decode_by_id` failed, and resolution silently
fell back to the metres default — rendering a millimetre model 1000× too large.
The pre-pass now tries the partial index first (fast path for unit-first files)
and falls back to a *complete* index when the unit chain isn't yet decodable, so
the scale is correct regardless of entity ordering. New
`try_extract_length_unit_scale` in `ifc-lite-core` distinguishes "not yet
resolvable from this index" from a genuine metres default; covered by unit tests.

**Ingest watchdog (viewer).** The added-model ingest path
(`parseStepBufferViewerModel`) gains the same size-aware stream watchdog the
single-model loader already had, so a stalled geometry stream surfaces a
recoverable error instead of hanging forever at "Processing geometry (N meshes)".
The watchdog plus its iterator teardown are extracted into a shared
`watchedGeometryStream` / `boundedIteratorReturn` helper (used by both loaders):
the teardown is now bounded so an abandoned generator parked on the very stall
the watchdog escaped can't re-wedge cleanup and swallow the timeout error.

**Camera framing.** When a second model is added, the viewport now unions the
bounds of all visible models and refits, so federated models are framed together
instead of the camera staying on the first model.
