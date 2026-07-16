---
"@ifc-lite/wasm": patch
---

Harden wasm geometry against malformed input (panic=abort there takes down the whole worker instance):

- A cyclic `FirstOperand` chain in a boolean clipping result (an entity referencing itself) no longer loops forever with unbounded memory growth; the chain walk tracks visited ids and breaks on a repeat.
- `remove_internal_membrane` no longer panics on NaN axis extents produced by non-finite file coordinates (uses NaN-safe `total_cmp`).
- Out-of-range `CoordIndex` values no longer wrap/truncate to arbitrary valid-looking vertices; index parsing saturates to an out-of-range sentinel and triangulation drops the affected vertex via a checked multiply.
