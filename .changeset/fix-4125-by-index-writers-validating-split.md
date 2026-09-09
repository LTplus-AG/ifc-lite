---
"@ifc-lite/export": patch
---

Refuse a STEP attribute edit rather than land it on the wrong attribute, in the three writers that set a slot by index (#4125).

`step-attribute-mutations.ts` (named and positional edits) and `retype.ts` split a record's argument list with the PERMISSIVE `splitTopLevelArgs` and then wrote `args[index]`. A permissive split still produces parts when the scan went wrong, and those parts are not the record's slots. On a record with two undoubled apostrophes, which is what an authoring tool emits when it forgets to double one, quote parity stays even and paren depth returns to zero, so nothing structural notices: `#1=IFCWALL('g',$,IFCLABEL('a's'),$,IFCLABEL('b's'),#5,#6,'T',.SOLIDWALL.);` split into seven parts for a nine-attribute class. Editing `Description` then overwrote `ObjectPlacement`, deleting the `#5` reference that was there, and reported `attributed: true`; retyping it to `IfcWallStandardCase` emitted eleven top-level arguments for a nine-attribute class.

All three now use `splitTopLevelStepArguments`, which carries a per-slot grammar check, and drop the edit when it refuses. The refusal is reported rather than left to look like a no-op: `SourceLineMutations` gains `unreadable`, and both passes that write a source line push a warning naming the entity.

Measured on 122 real IFC files (19,461,436 records): zero records change verdict, so no file that previously mutated stops mutating. That sweep found no argument list carrying a `/* ... */` comment, which is why it did not catch the Rust splitter refusing one; that was caught in review and fixed afterwards, and the fix only widens what is accepted, so the conclusion is unaffected.

The Rust exporter had the same shape (`step_text.rs`'s `apply_attr_mutations_counted`). Its splitter now validates too and lives in `step_slot.rs`, and each refusal is counted into `StepStats::attribute_edits_refused`, which callers of `export_step_with_stats` can read. The wasm JSON path does not surface that count today: `export_step` discards the stats, so nothing reaches `export_step_json`. Wiring it through is a separate change. The inputs both languages must refuse are pinned to one shared fixture, `rust/export/tests/fixtures/step_refuse_vectors.json`, following the `step_escape_vectors.json` precedent.
