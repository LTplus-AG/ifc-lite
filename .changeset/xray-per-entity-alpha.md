---
"@ifc-lite/renderer": minor
---

X-Ray now fades the entities named in `RenderOptions.transparencyOverrides` / `ghostExceptIds`, not their whole colour batch (#4129).

Flat geometry is drawn as merged colour batches with one uniform alpha per draw, so an override on a single entity used to fade every batchmate that happened to share its colour — a consumer asking to X-Ray one roof slab got the whole roof, and anything keyed on its own X-Ray set (picking, counts, exports) then disagreed with what was on screen. That was the documented contract; this changes it.

A batch whose entities no longer resolve to one alpha is now partitioned into one cached sub-batch per distinct alpha, reusing the same partial sub-batch machinery that already draws a subset of a batch under hide/isolate and colour-override promotion. No vertex format, shader, or pipeline change, and a batch that needs no split still draws exactly as before.

Where a batch cannot be partitioned — its CPU geometry was released or evicted, it is colour-merged (many entities per `MeshData`, tagged per vertex), or it carries more than 8 distinct alphas — the renderer falls back to the previous whole-batch minimum alpha, so degrading fades too widely, never drops geometry. `ghostExceptIds` gains the same granularity: an excepted entity sharing a batch with ghosted ones now stays solid on its own, without having to be co-selected.

Two ordering fixes come with it, both reachable before this change: partial sub-batches are cached per requesting slot rather than per colour, so two slots trading id sets between frames can no longer destroy a clone the other is drawing from; and transparent sub-batches are drawn after every opaque one in that pass, since a ghost writes no depth and an opaque draw landing after it painted straight over it.

The sub-batch cache epoch now also carries the SELECTION set, because selection exempts an entity from fading and therefore decides which subset it lands in. The cache's fast path returns a cached clone without re-reading the id set it was handed, so an input missing from the epoch surfaced as a stale subset on screen rather than an extra rebuild. Selection only counts while X-Ray is active, so ordinary clicks still cost nothing.

Alpha-split slots orphaned by an X-Ray edit — a batch that stops needing a split, or a group count that shrinks — are now retired on the frame the state changes, instead of being pinned until hide/isolate and X-Ray are all switched off. These clones sit outside the GPU residency budget, so nothing else would have reclaimed them during a long X-Ray session.

Rebuilding a colour batch now releases its cached sub-batches too. A slot key embeds the batch id and the replacement gets a fresh one, so the old clones were stranded with live GPU buffers — reachable whenever more geometry landed in a bucket while hide/isolate was on, such as a federated model add. Every other batch-destroying path already cleared the cache; this one did not.
