---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

Fix two model-federation regressions: wrong unit scale and a load-time hang.

**Unit scale (models rendered 1000× oversized).** The streaming geometry
pre-pass (`buildPrePassStreaming`) resolved `unitScale` from a *partial* entity
index — the rows scanned up to the first `IFCPROJECT`. Many real exports
(Revit) place the `IFCPROJECT` and its `IFCUNITASSIGNMENT` *after* the bulk of
the geometry, so the assigned `IFCSIUNIT` wasn't indexed yet; `decode_by_id`
failed and resolution silently fell back to the metres default. A millimetre
model then rendered 1000× too large, which also pushed its coordinates past the
RTC large-coordinate threshold — so when federated, one model was flung
off-screen or dwarfed the other (the exact symptom depended on load order).

The pre-pass now tries the partial index first (fast path for unit-first files)
and falls back to a *complete* index when the unit chain isn't fully decodable,
so the scale is correct regardless of entity ordering. New
`try_extract_length_unit_scale` in `ifc-lite-core` distinguishes "not yet
resolvable from this index" from a genuine metres default; covered by unit
tests.

**Hang when adding a second model.** `processParallel` only ended once *every*
spawned geometry worker reported `complete`. When the browser fails to
instantiate a worker (the "Attempting to create a Worker from an empty source"
warning), that worker never reports `ready`, `complete`, or `error`, so the
stream wedged forever at "Processing geometry (N meshes)". The pool now tracks
which workers actually came up, dispatches job slices only to live workers (so a
failed worker's geometry isn't dropped), and finalizes completion against the
live set after a readiness deadline — the model loads complete on the surviving
workers instead of hanging. The added-model ingest path also gains the same
size-aware stream watchdog the single-model loader already had, as a backstop
for genuine mid-stream stalls.
