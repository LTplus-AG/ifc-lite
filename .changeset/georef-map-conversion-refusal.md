---
"@ifc-lite/export": patch
---

Report a requested `IfcMapConversion` that the STEP export could not write, instead of returning a file that looks like none was asked for (#2067).

`StepExporter.export()` writes a new `IfcMapConversion` only when it can resolve an `IfcGeometricRepresentationContext` to use as `SourceCRS`; with no candidate it skips the conversion and writes the requested `IfcProjectedCRS` alone. Skipping is the right call — an `IFCMAPCONVERSION` whose `SourceCRS` points at a `#id` the export never writes is an invalid file — but the resulting output is byte-identical to one where the caller requested a CRS and no map conversion at all, so nothing distinguished "you asked for nothing" from "we refused". The refusal was written to `console.warn` and nowhere the caller could read.

`StepExportResult.stats` now carries `warnings: string[]`, the same shape `MergeExportResult.stats.warnings` already uses, and the refusal is pushed there as well as to the existing console line (both from one shared message string, so they cannot drift). It is populated on both return paths, including the delta-only early return, where a georeferencing-only export can refuse the conversion and then have nothing else to write. `warnings` is empty on every export that refuses nothing, so a caller can treat a non-empty array as "the file is not everything you asked for".

Which sessions this affects: only those that request a map conversion against a model with no usable `IfcGeometricRepresentationContext` — a file that never had one, or (once the georeferencing resolution moves to the effective index, #2048) a session that deleted every one of them. Ordinary georeferencing edits against a model with a representation context are unchanged and report nothing.

Not changed here: an overlay-created replacement context is still not used as `SourceCRS`. That behaviour was verified rather than assumed — with the id allocator watermarked above the fixture's maximum `expressId`, a context created through `MutablePropertyView.createEntity()` is written to the output file but never selected as `SourceCRS`, both before and after #2048. Selecting one would need its own decision, because `createEntity` does not require the mandatory `WorldCoordinateSystem` placement, so an overlay-created context can be a schema-invalid target.
