---
'@ifc-lite/wasm': patch
---

`extract_symbolic_item` (`rust/processing/src/symbolic/item_walk.rs`) now
reports internally when `MAX_ITEM_DEPTH`, `MAX_ITEM_REVISITS`, or the item
path-cycle guard fires, instead of silently returning whatever geometry it
had collected so far. `symbolic/mod.rs` logs a `tracing::warn!` (product id,
item id, representation, which bound) when that happens.

Brings this walk's two bounds and its path guard in line with the sibling
`IfcMappedItem` bound in `rust/geometry/src/router/processing.rs:338`, which
already raises an `Err` instead of returning silently.

No change to `SymbolicData`'s shape, no new field, nothing on the wire — the
extracted geometry is byte-identical to before. This is a logging-only
change confined to the symbolic walk; `extract_symbolic_data`'s public
signature is unchanged and every consumer (the HTTP server, both
wasm-binding paths) is unaffected. A richer diagnostics field on
`SymbolicData` naming which bound fired, for callers to act on rather than
just log, is a separate, larger change (public API / wire-format) left for
its own decision.
