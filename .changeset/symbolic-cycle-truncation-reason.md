---
"@ifc-lite/server-client": patch
---

Fix a symbolic-extraction cycle silently truncating with no reported reason.

`extract_symbolic_item`'s path guard (`ItemWalk::enter_node`) returns `false` when the walk revisits a node already on its current path — the representation graph closes a cycle. Both call sites (`item_walk.rs`, for a revisited item id, and `items.rs`, for a revisited representation reached through a different item id) dropped the subtree with a bare `return` and recorded nothing, so a cycle-truncated `SymbolicData` was byte-identical to a complete one: no field, count, or flag distinguished them.

Both sites now call the existing `note_item_bound` reporting mechanism with a new `SymbolicTruncationReason::ItemCycle` variant (wire spelling `item-cycle`), so a cycle-truncated result now carries `truncated: { reason: "item-cycle", emitted, limit: undefined }` like every other bound. `SymbolicTruncationReason` on the TypeScript side gains the same variant.
