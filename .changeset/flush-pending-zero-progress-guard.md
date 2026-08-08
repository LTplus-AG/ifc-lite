---
"@ifc-lite/renderer": patch
---

Harden `Scene.flushPending`'s mesh-queue drain loop against a future regression, not an observed bug: today the chunk-end computation is provably always at least one mesh past the read cursor (three constants combine to guarantee this — see the comment at the call site), but nothing at the loop itself said so. Extracted the chunk-end computation into a pure `computeFlushChunkEnd` helper and added a zero-progress `break`, so that if a future change ever broke one of those three invariants the loop would stop instead of spinning the main thread at 100% CPU with zero allocation.

Also closed a latent gap in the same computation: `meshQueue[i].indices.length` was read unchecked when deciding whether a chunk exceeds the index-volume cap. A `NaN` there would have made the cap silently vacuous (`NaN > cap` is always `false`), producing one indivisible oversized chunk instead of stopping. The cap check is now written in the codebase's established NaN-rejecting form (`!(x <= cap)` instead of `x > cap`), which is a no-op for all valid input and closes the chunk defensively if it ever sees `NaN` or `+Infinity`.

No behavior change on any real input; this is defensive hardening surfaced while investigating #2379.

Also rejects `-Infinity` specifically, which the `!(x <= cap)` form above didn't already close (`-Infinity <= cap` is always `true`, so the check passes it through). Folding it into the running `chunkIndices` total then poisoned that total to `-Infinity` too, making the cap vacuous for every mesh after the malformed one, not just that one mesh. Every non-finite `indices.length` now closes the chunk explicitly, before it can reach either the cap comparison or the running total.
