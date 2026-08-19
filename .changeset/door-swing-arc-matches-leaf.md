---
'@ifc-lite/drawing-2d': patch
---

Fix door swing arc opening into the opposite room from the drawn leaf.

`DoorSymbolGenerator`'s swing arc was derived purely from `wallDir` plus a
hardcoded `direction > 0 ? Math.PI : 0` sign, ignoring the `swingDir`
parameter entirely. The door leaf line, meanwhile, correctly used `swingDir`
for its open-position tip. Since the arc traces the path of that same tip as
it swings from closed to open, the two are required to end at the same
point — instead the arc swept to the wall side opposite the leaf, so a
door's swing arc and its leaf pointed into different rooms in every
generated drawing.

`generateArc` and `generateArcSVGPath` now derive both the arc's start and
end angle from `swingDir` (sweeping back by the swing angle in the
hinge-side's rotational sense), so the arc always terminates exactly at the
leaf's open tip, for all four swing types (`SINGLE_SWING_LEFT/RIGHT`,
`DOUBLE_SWING_LEFT/RIGHT`).
