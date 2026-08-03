---
'@ifc-lite/diff': minor
---

Add opt-in **split / merge detection** to `diffModels` (issue [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)) — one wall that became three, three panels that became one slab. Neither is a rename, a move or a reshape, so content matching left all four elements sitting in the residue as unrelated adds and deletes.

`detectSplitMerge: true` (effective only alongside `matchUnpairedByContent`) adds a fourth stage over that residue and reports what it finds on `ModelDiff.splitMerges`, as `SplitMergeClaim`s.

**Purely additive.** A claim never retires a `DiffEntry` and never touches `counts`: a split binds `k + 1` entities on ONE evidence chain, so a single wrong claim would delete `k + 1` real changes. A UI groups the underlying add/deletes under the claim. For the same reason no claim ever becomes an identity-map entry — identity is not a relation that survives being split. Running on the residue rather than on the raw diff is load-bearing too: renames and moves must be retired first, or a re-GUIDed wall plus one genuinely-new fixture inside its box fakes a volume-conserving "split" out of two unrelated things.

`confidence` names three evidence profiles instead of scoring them, because the difference between them is a difference in KIND of evidence: `verified` (pieces inside the whole's extent + complete volumes agreeing within `splitVolumeTolerance`), `extent` (inside the extent + per-axis interval coverage, volume missing somewhere and never refuted), and `displaced` (a cluster that moved out of the old extent, accepted only on complete volumes, congruent sorted extents, and a pairing unique in both directions).

Volume is used **asymmetrically**, which is what makes the sparse new `EntityFingerprint.volume` useful: as proof it requires completeness, as refutation a partial sum already suffices — if what is known overruns the whole, no unknown brings it back down. A failed volume test is a REFUTATION, never a reason to fall back to the weaker tier; the extent tier exists for the absence of evidence only. Subsets are never enumerated: the tolerance is exactly why, since a widened band lets several subsets qualify and a non-unique answer is an abstention here. The one bounded exception is a single same-class interloper inside the container whose own volume explains the whole overshoot, which is reported on `claim.excluded`.

Defaults: `splitVolumeTolerance` 0.03, `splitPaddingMin` 0.05, `splitPaddingRatio` 0.01, `maxSplitPieces` 256 (a performance bail, never a semantic rule — a precast slab field really is dozens of panels). All four are coerced through the same non-finite guard as the existing tolerances.

`ModelDiff.splitMerges` is **absent** rather than empty when the stage did not run — off, without `matchUnpairedByContent`, or under either geometry abstention. Presence records that the detector ran; emptiness records that it ran and found nothing. The two are different answers and a caller may rely on the distinction.

New exported types: `SplitMergeClaim`, `SplitMergeConfidence`, `SplitMergeKind`. Default `false` — existing callers get byte-identical results.

What it deliberately cannot see is documented rather than hidden: cross-class splits, two or more same-class interlopers in one container, `extent` firing on a redesign in place or on a perimeter enclosing an unfilled middle, `displaced` abstaining between two congruent clusters in a repetitive building, moved splits under a non-90° rotation, and a real split that changed more than 3% of its material while carrying full volume data.
