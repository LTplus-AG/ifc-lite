---
"@ifc-lite/export": minor
"@ifc-lite/viewer": patch
---

Apply pending edits in merged (federated) export. `MergeModelInput` gains an optional
`mutationView`; `MergedExporter.exportAsync` now bakes each model's edits (attribute /
property / quantity / retype / positional mutations and overlay-created entities) into its
source via `StepExporter` before merging, so federated export round-trips edits exactly like
single-model export. Previously the merged path read raw source bytes and silently dropped
every mutation — only single-model export reflected edits ([#1406](https://github.com/LTplus-AG/ifc-lite/issues/1406)).

Models without pending edits pass through unchanged (no export/parse cost). The synchronous
`MergedExporter.export()` throws if a model carries pending edits, since baking needs the
async parser. The viewer's "Merged (All Models)" export now passes each model's mutation view
(gated by the Apply Mutations toggle).
