---
"@ifc-lite/parser": minor
"@ifc-lite/server-client": patch
---

Bound symbolic extraction by output size, and report every truncation with the reason it happened.

`extract_symbolic_data` accumulated into one `SymbolicData` across every product, so the per-item recursion bounds left the file-level total unbounded: a crafted 1.13 MB upload produced 20,002,500 primitives and 2.74 GB RSS on a path the server calls with raw uploaded bytes. Separately, well-formed drawings lost content to the per-item bounds with no way for a consumer to tell a clipped result from a complete one.

Extraction now stops at 2,000,000 primitives or 256 MiB of estimated output, whichever comes first, and `SymbolicData` gains a `truncated` field naming which bound fired: `element-count`, `output-bytes`, `item-depth` or `item-revisits`.

The byte bound is the load-bearing one, and it has to charge **every** variable-length field. A count-only cap is not a memory bound: per-primitive size is attacker-controlled and the fan-out re-emits one leaf up to the cap, cloning it each time. Charging only the obvious field is the same hole one door along — a text leaf with a 4 KB `BoxAlignment` reached 3.45 GB while the accountant thought it had spent 54.9 MB and the bound never fired. Both are now charged and both are pinned by tests.

The per-item reasons matter as much as the extraction ones: a nested block import can lose 60% of its curves to the per-item revisit budget while the whole-file totals sit far below either extraction bound, so a diagnostic reporting only the extraction bounds would have stayed silent on exactly that case. A per-item bound marks the result truncated but does not stop the extraction — one deep item must not abandon the rest of the file.

Marked `minor`: `SymbolicData` gains a public field, so an exhaustive struct literal in a downstream Rust consumer needs `..Default::default()`. The wire shape is unchanged for a complete extraction — `truncated` is `skip_serializing_if`, so cache keys do not move and JSON written before the field existed still deserializes.

The flag is carried through the WASM boundary (`SymbolicRepresentationCollection.truncatedAt`) as well as the HTTP route, and added to the `SymbolicData` TypeScript interface. Geometry is client-side only in the viewer, so a flag surviving only the server route would have left the browser silently truncating.

Not addressed here: `apps/server/src/routes/parse/json.rs` clones the response and serializes it up to three more times after its admission permit scope ends. That amplifies the whole `ParseResponse` (dominated by meshes), is a different mechanism from the structural amplification this fixes, and is deferred rather than closed.
