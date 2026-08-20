---
"@ifc-lite/wasm": patch
---

Fix the native (Rust) merged/federated IFC exporter emitting duplicate GlobalIds.

`export_merged_with_stats` (`rust/export/src/merged.rs`) only ID-offsets each
subsequent model's STEP entity instance names (`#123`) and rewrites the
`#`-references that point at them. `GlobalId` is a separate 22-character IFC
GUID attribute on every `IfcRoot` entity, untouched by that offset. Federating
two models that share an element -- the same file merged twice, a shared
grid, a linked type -- emitted that element's GlobalId twice into one file, a
spec violation independent of the exporter's other parity gaps (tracked in
#2951).

Every model after the first is now checked for a GlobalId already emitted by
an earlier model; a collision gets a fresh, deterministic GlobalId minted for
it (seeded from the original id and the source model's index, so output is
reproducible) rather than being written through unchanged. This mirrors the
"keep + re-stamp" branch of `MergedExporter`'s GlobalId reconciliation in
`packages/export/src/merged-exporter.ts` -- the branch that always applies
here, since the Rust path does not yet do the unit/spatial unification that
lets the JS path's other branch drop-and-remap a duplicate onto one shared
instance instead. That unification work remains open under #2951; this change
only removes the duplicate-GlobalId defect for the offsetting path Rust
already has.
