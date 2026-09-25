---
"@ifc-lite/wasm": minor
---

`exportStep` now accepts the mutation log `MutablePropertyView.exportMutations()` returns as `mutationsJson`, and writes it through a new Rust writer (`ifc_lite_export::export_step_with_log`) whose output is byte-identical to the TypeScript `StepExporter` for the same edits, apart from the GlobalIds of generated records (#5941, part 1). Property and quantity edits inside existing sets (update, delete, whole-set deletion, type-owned sets repointed through `HasPropertySets`) and root-attribute edits are applied while the source records stream through, so saving edits no longer needs the whole file in the JS heap. The older `{ attributeUpdates, propertyMutations }` payload is unchanged. A log carrying a mutation kind the writer does not apply yet is refused rather than exported without it.
