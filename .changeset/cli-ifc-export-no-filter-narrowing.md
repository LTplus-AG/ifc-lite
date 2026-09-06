---
"@ifc-lite/cli": patch
---

Fix `ifc-lite export <model> --format ifc` silently narrowing to fewer entities than the model contains when no `--type`/`--storey`/`--where`/`--limit` filter was given. The export command always passed a populated entity-ref array to the backend's IFC exporter, which treats any non-empty array as an isolation request; an unfiltered export's ref array (every queryable entity) is non-empty, so it took the isolation path instead of a full-model pass-through, dropping entities the query layer doesn't surface directly. An unfiltered export now passes the backend's existing "whole model" signal (an empty ref array, already used elsewhere in this codebase) so it matches calling the writer directly.

A genuinely filtered `--format ifc` export now also reports the entity count it wrote versus the model's total on stderr, and fails loudly instead of silently exporting the whole model when a filter matches zero entities (mirroring the existing behavior of the Rust-backed export formats).
