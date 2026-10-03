# #6232 split metadata references

The schema-known RelatedObjects lists written by the shared metadata-clone helper use the existing `refList`/`refToken` decoder/encoder. Parsed numeric entity IDs become `#id` reference tokens on overlay writes; ordinary numeric property and quantity values are unchanged.

A real Bonsai model context plus an authored wall/space persisted into source reproduces the failure. Splitting the space originally emitted `IfcRelDefinesByProperties.RelatedObjects` as `(10005,10036)`, so downstream property/quantity extraction lost source memberships after reload. Both wall and space roundtrip controls fail before the reference repair; the wall control passes after reference encoding alone.

A new split space already has a freshly authored `Pset_SpaceCommon` and `Qto_SpaceBaseQuantities`. Reference encoding alone attaches the old same-name sets as well. The parser's name deduplication exposes the fresh target set, but the IFC graph still contains duplicate memberships. The helper now preserves existing target sets and clones only distinct imported sets. Retained source sets and their declared values stay unchanged; arbitrary imported measurements are not recalculated.

`metadata-clone-roundtrip.test.ts` verifies source Pset/Qto identities and values after actual export/reparse, distinct imported memberships on the new piece, unchanged ordinary numeric audit values, fresh target area/volume, and a single actual graph membership for each same-name target set. The larger retained source's original imported floor-area/volume can remain stale after a generic space split; this limitation is separate from the Room writer's canonical metadata updates.

Copy uses `duplicateInStore`'s separate association replay, which already emits fresh `#id` reference lists; it does not call this helper. This repair does not replace that path.

The final local qualification ran through root Turbo: 15 native split/metadata controls and eight viewer metadata controls passed with no skips; full typecheck passed 111 tasks and covered all 3,347 test files in 57 packages. The native oracle reused the same verified main-default WASM and provenance recorded in `6232-split-placement-basis.md`; no new Rust build is claimed. Receipts: `/tmp/6232-metadata-final-native-verified.log`, `/tmp/6232-metadata-final-viewer.log`, `/tmp/6232-split-metadata-typecheck.log`.

The final native run uses Turbo `--force` and verifies the WASM hash after completion, preventing prerequisite cache restoration from changing the tested runtime. Viewer metadata controls do not make a native mesh claim. Final root lint covers 8,380 files with no errors (`/tmp/6232-split-metadata-lint.log`).
