---
"@ifc-lite/geometry": patch
---

Sharded pre-pass stage 3: two style slices per worker, dispatched round-robin. The styles tail is set by the slowest worker, and the OS occasionally schedules one onto a slow core — halving the slice size halves the damage, and the smaller slices interleave better with the concurrent pre-pass/parser work. Measured on an 883 MB CATIA model: styles 9.7-10.2s -> 5.5-5.8s, first visible geometry 9.9s -> ~7s (serial baseline: 14.3s). Slice order stays file order and the merge is by slice index, so first-wins precedence is unchanged.
