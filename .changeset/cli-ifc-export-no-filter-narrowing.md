---
"@ifc-lite/cli": patch
---

Fix `ifc-lite export <model> --format ifc` silently narrowing to fewer entities than the model contains when no `--type`/`--storey`/`--where`/`--limit` filter was given. The export command always passed a populated entity-ref array to the backend's IFC exporter, which treats any non-empty array as an isolation request; an unfiltered export's ref array (every queryable entity) is non-empty, so it took the isolation path instead of a full-model pass-through, dropping entities the query layer doesn't surface directly. An unfiltered export now passes the backend's existing "whole model" signal (an empty ref array, already used elsewhere in this codebase) so it matches calling the writer directly.

A genuinely filtered `--format ifc` export now also reports the entity count it wrote versus the model's total on stderr, and fails loudly instead of silently exporting the whole model when a filter matches zero entities (mirroring the existing behavior of the Rust-backed export formats).

Also split `export.ts`'s Rust-backed exporters (`obj`/`gltf`/`glb`/`jsonld`/`ifcx`/`usd`/`step`, and the shared wasm `GeometryProcessor` bootstrap they use) into `export-rust-formats.ts`, to bring the file back under the repo's module-size budget after this fix's own growth pushed it over. Pure internal refactor: no behaviour change, and `@ifc-lite/cli`'s public API is unchanged.
