---
"@ifc-lite/wasm": minor
---

The Rust mutation-log STEP writer behind `exportStep` now also applies `DELETE_ENTITY` (with the TypeScript exporter's reference cleanup: list slots narrowed, relationships naming a deleted entity in a single-valued slot withheld), `UPDATE_ENTITY_TYPE` (attributes re-laid-out by name, `PredefinedType` validated or written as `USERDEFINED`), `UPDATE_POSITIONAL_ATTRIBUTE` and `CREATE_ENTITY`, whose payloads travel in the log's `newEntities` member (#5941, part 2). Output stays byte-identical to `StepExporter` apart from generated GlobalIds. A `CREATE_ENTITY` whose payload is missing from `newEntities` is refused rather than dropped with the edits recorded against it.
