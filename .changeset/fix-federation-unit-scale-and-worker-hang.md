---
"@ifc-lite/wasm": patch
---

Fix federated unit scale (models rendered 1000× oversized) and harden the
added-model ingest against stalls.

**Unit scale.** The streaming geometry pre-pass (`buildPrePassStreaming`)
resolved `unitScale` from a *partial* entity index — the rows scanned up to the
first `IFCPROJECT`. Many real exports (Revit) place the `IFCPROJECT` and its
`IFCUNITASSIGNMENT` *after* the bulk of the geometry, so the assigned
`IFCSIUNIT` wasn't indexed yet; `decode_by_id` failed and resolution silently
fell back to the metres default. A millimetre model then rendered 1000× too
large, which also pushed its coordinates past the RTC large-coordinate
threshold — so when federated, one model was flung off-screen or dwarfed the
other (the exact symptom depended on load order).

The pre-pass now tries the partial index first (fast path for unit-first files)
and falls back to a *complete* index when the unit chain isn't fully decodable,
so the scale is correct regardless of entity ordering. New
`try_extract_length_unit_scale` in `ifc-lite-core` distinguishes "not yet
resolvable from this index" from a genuine metres default; covered by unit
tests.

**Ingest watchdog (viewer).** The added-model ingest path
(`parseStepBufferViewerModel`) gains the same size-aware stream watchdog the
single-model loader already had, so a stalled geometry stream surfaces a
recoverable error instead of hanging forever at "Processing geometry (N
meshes)".
