---
"@ifc-lite/clash": patch
---

Fix two origin-dependent defects in the OBB clash path that made flush and coplanar contacts classify differently depending on where the model sits in world space, and made a zero-volume contact report a penetration depth the size of the contact face.

**A flush contact reported the shared face's extent as its depth.** `obbPenetrationDepth` treats an axis whose overlap falls inside its own noise band as inconclusive — correctly declining to let it separate the pair, but also dropping it from the depth minimum entirely. For two boxes in flush face contact the contact-normal axis *is* the minimising axis, so deleting it handed the minimum-translation distance to the next-smallest candidate: a 0.05 m curtain-wall panel resting against a mullion reported 0.85 m of penetration. An unresolvable axis now contributes a depth candidate of zero instead of none. "Each remaining axis is a valid upper bound, so the result stays conservative" holds for the boolean verdict and not for the depth, where deleting the minimising axis can only over-report.

**A box stopped being recognised as a box when it was translated.** `detectObb` required its three face-normal families to be mutually perpendicular to within an absolute `OBB_EPS = 1e-6`. Those normals are computed from vertices that arrive as f32, so their direction error grows with coordinate magnitude and shrinks with feature size. For a 0.05 m thick rotated panel the worst `|dot|` between two genuinely perpendicular faces measures 2.25e-7 at the origin, 1.19e-6 at 7.4 m and 2.67e-4 at 1 km — so beyond a few metres a perfect box was rejected, and the pair silently fell off the measured-OBB path onto the coarser AABB estimate. The tolerance is now derived from the triangle's own conditioning (`coordErr * (|e1| + |e2|) / |e1 x e2|`), with `OBB_EPS` retained as a floor so geometry at the origin is judged exactly as strictly as before.

Both fixes land in the TypeScript and Rust kernels together, which the differential suite requires.

This does not eliminate every origin dependence: element vertices and AABBs still cross the WASM boundary as f32, so a rigid translation still re-quantises them. That is a separate, known limitation, reported alongside these two defects.
