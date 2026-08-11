---
'@ifc-lite/clash': minor
---

Decide duplicates by a distance in metres, not by AABB intersection-over-union.

`findDuplicates` called two elements the same object when their bounding boxes
overlapped at IoU ≥ 0.9. IoU is a ratio, so that setting carried no physical
tolerance: for two equal boxes offset by `d` along an axis of extent `e` the IoU
is `(e − d) / (e + d)`, and the 0.9 default therefore allowed `d ≤ e / 19`.
Measured over four common shapes and all three axes, the displacement that still
counted as a duplicate ranged from 5 mm (across a DN100 pipe) to 421 mm (in the
plane of an 8 m slab) — a 93× spread from one number nobody set. A duplicated
pipe nudged 5 mm was missed while a duplicated slab moved 400 mm was still
reported.

The gate is now `positionTolerance`, a distance in metres (default 10 mm),
applied to the largest distance any corner of one box has to travel to reach the
matching corner of the other. For two equally-sized boxes that is exactly the
distance between their centres, whatever the shape and whatever the direction, so
the effective tolerance is 10 mm for every shape on every axis and on the
diagonal. A difference in size counts too — concentric boxes whose faces differ
by δ are δ apart — so position and shape are checked by one number with no second,
dimensionless knob. Boxes that do not touch at all are never paired, so an
element smaller than the tolerance cannot be matched to a neighbour it does not
intersect.

`ClashResult.settings.tolerance` now reports the value that actually decided the
matches. It previously advertised `positionTolerance`, which governed only the
degenerate/planar fallback — the number on screen was not the number doing the
work.

What did not change: this is still a bounding-box test. Two elements with the
same bounds and different solids inside them — a duct inside a shaft, an assembly
and its own envelope — remain indistinguishable, and separating those needs a
narrow phase this pass deliberately does not run.

Compatibility. `positionTolerance` keeps its name and its default and is now the
primary control; callers that raised it to loosen the planar fallback will find
it loosens the whole pass. `exactTolerance` (default 1 mm) replaces
`exactThreshold` for the `major`/`minor` split. `iouThreshold` and
`exactThreshold` are deprecated but still honoured: passing either restores the
previous IoU **matching gate** for that call — which pairs are reported,
including the old degenerate/planar fallback, and the old `settings.tolerance`
reading — rather than silently reinterpreting a ratio as a distance. It does
not restore the rest of the old behaviour: severity and self-pair identity
follow the new rules in every mode (see the shape-signature changeset).

One matching change falls out of requiring the boxes to touch: two
zero-thickness sheets offset a few millimetres **along their own normal** are
disjoint and are no longer reported (the old planar fallback reported them).
Geometry with clear air between the surfaces is two objects; the legacy IoU
mode keeps the old reading.

Across five public models the set of reported pairs is unchanged (1 / 0 / 0 / 0 /
32). In the one model with a substantial count, eight same-triangle-count pairs
that sit 1.7–4.5 mm apart move from `major` to `minor`: they are near-coincident,
not exact copies, and the remaining 22 exact ones are all within 0.9 mm.
