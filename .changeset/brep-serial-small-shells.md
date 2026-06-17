---
"@ifc-lite/geometry": patch
---

Skip rayon for small BReps — the fork-join overhead dwarfs the trivial triangulation.

`FacetedBrepProcessor` dispatched every shell's face triangulation through rayon `par_iter`, but real-world BReps are overwhelmingly tiny (6–50 faces of trivial tri/quad/convex fast-path geometry — e.g. Tekla steel detail parts), where the parallel fork-join dispatch costs far more than the work it parallelises. A serial path gated on a 64-face threshold avoids that overhead (and the nested-parallelism contention under the per-element worker pool); `par_iter` still runs for large shells. Output is byte-identical — `collect` preserves index order and each face's f32 result is unchanged.

Measured native, byte-identical (strict mesh hash unchanged): a 48k-BRep structural model −16.6% geometry time, an architectural BRep-heavy model −37%. Scales with how many small shells a model has; the win is larger in the browser where the nested parallelism is more expensive.
