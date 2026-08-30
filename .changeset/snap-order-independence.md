---
'@ifc-lite/wasm': patch
---

`snap_near_duplicates` (`rust/geometry/src/csg/consolidate/conform/snap.rs`) decided whether a candidate snap would duplicate an existing ring vertex, or collide with another vertex's own chosen candidate, by scanning the live `ring` array as the pass proceeded. A vertex processed earlier in iteration order showed its NEW (already-snapped) position to that check; one not yet reached still showed its ORIGINAL position — so whether a given snap was accepted or refused, and which of two vertices independently choosing the same candidate point got to keep it, depended on which index the ring walk reached first, not on the ring's actual geometry. The same physical ring, stored starting from a different index, could snap differently.

The function is now split into two phases that only ever read pre-pass snapshots. Phase 1 picks each vertex's nearest in-tolerance, f32-visible candidate from a snapshot of the ring taken before any vertex moves. Phase 2 accepts a chosen candidate only if it does not duplicate another vertex's ORIGINAL position, and — when two or more vertices independently chose the exact same candidate point — only the one strictly closer to it (by squared distance to its own original position) may use it; an exact tie means none of them may, since there is then no unambiguous winner without depending on iteration order.

Two tests pin this: one asserts the same ring, walked in reverse storage order, produces the same physical result; the others exercise two vertices (adjacent and non-adjacent) independently choosing the same candidate and assert the tie-break resolves deterministically rather than by traversal-order luck.
