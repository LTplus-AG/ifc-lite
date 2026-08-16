---
'@ifc-lite/clash': patch
---

Duplicate detection abstains on bounds it cannot compare, and the position
tolerance is documented as the bound it actually is.

**Non-finite bounds no longer report a pair.** The distance gate was written as
two rejections (`if (!boxesTouch(...)) return; if (dist > tolerance) return;`).
Every comparison against `NaN` is false, so an element whose `bounds` carry `NaN`
fell through both rejections and was reported as coincident with elements 100 m
and 500 m away — and, not being evicted from the sweep either, with every element
visited after it. The gate is now `if (!(dist <= tolerance)) return;`: an
acceptance, so a distance that cannot be compared abstains instead of asserting a
match. The deprecated `iouThreshold` branch is left as it is and does **not**
match: on two solid `NaN` boxes it also reports nothing, but only because
`similarity` clamps them to 0, and against a degenerate (zero-volume) element it
takes the `aabbApproxEqual` fallback — whose per-axis comparisons are all false
against `NaN` — and asserts the pair even at the default 0.9. Both behaviours are
now pinned by tests so the difference is on record.

**And one non-finite element no longer loses duplicates elsewhere.** The broad
phase sorted element indices by `bounds.min[axis]` with a subtracting comparator,
which answers `NaN` for every comparison involving a non-finite minimum. That is
not a total order, so V8's TimSort returned an arbitrary permutation of the whole
array; the sweep then saw minima going backwards, evicted boxes that were still
live, and unrelated true duplicates were silently dropped — measured, 12
coincident pairs in a 25-element model became 11. The comparator now compares a
key instead of subtracting, with non-finite minima ordered last. Nothing changes
for a model whose bounds are all finite.

**And non-finite coordinates no longer become bounds.** `fromPositions`
(`math/aabb.ts`) excluded `NaN` only as a side effect of `<` and `>` both failing
against it; `±Infinity` propagated straight through into the bounds, and two
elements each carrying `-Infinity` on the same axis give a NaN `boxDistance` that
`boxesTouch` passes — a NaN distance without a NaN vertex. Whether the geometry
pipeline can emit an infinite vertex is not established, so treat that as a
mechanism rather than an observed path; the guard closes it at the source either
way. `fromPositions` now requires each coordinate to be finite *after* the
transform is applied, per coordinate — the same rule `NaN` already got, so the
finite coordinates of a partly poisoned vertex still count. Coordinates a real
file can produce are finite, so no viewer or CLI result changes for them.

**`positionTolerance` is an upper bound, not a per-axis guarantee.** The 1.7.0
entry said the effective tolerance was "10 mm for every shape on every axis and
on the diagonal". `boxDistance` is isotropic, but the pass also requires the two
boxes to touch — enforced both by `boxesTouch` and, independently, by the broad
phase's eviction on the axis it sweeps — and two copies stop touching once the
offset exceeds the element's own extent on the offset axis. So the effective
tolerance is `min(positionTolerance, extent on that axis)`: measured, a
`[4, 0.2, 3]` m wall matches within 10.00 mm on all three axes, while a
`[1.2, 0.002, 2.4]` m plate matches within 10.00 / 2.00 / 10.00 mm. A duplicated
2 mm cladding panel offset 5 mm along its own normal is therefore not reported.

That is deliberate rather than newly broken — the previous IoU gate missed the
same pair, and inflating the touch test to make the pass isotropic reopens
exactly the case the touch test exists to close (a 5 mm fixing pairing with a
neighbour it never intersects); it breaks the two tests that pin that. So the
behaviour stands and the claim is corrected, in the 1.7.0 changelog entry, on
`positionTolerance`, on `boxDistance` and on `boxesTouch`, with a test pinning
the real per-axis property so prose and code cannot drift apart again.

Also corrected: a comment on the broad phase claimed "a pair that does not touch
is rejected by the gate anyway", which holds for the distance gate but not for
the deprecated IoU gate, whose degenerate fallback does match disjoint boxes.
Comment only — that behaviour predates the distance gate and is unchanged.
