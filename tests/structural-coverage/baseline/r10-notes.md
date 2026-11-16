# R10 derived supports

Product source: main `5edf312b07` (R9) plus the derivation support fix in this revision. The probes are unchanged. R0 to R9 are retained.

Rows: **106/119 -> 106.5/119** (met 93 -> 94, partial 26 -> 25, missing 0 -> 0). Cells: **756/774 -> 756.5/774**. Capability: 8.5/9 -> 9/9. All other level totals are unchanged. The online ratchet against R9 passes with no row or cell dropped.

## Every changed cell

The full summary comparison against R9 has exactly one changed cell.

| Row | Level | R9 -> R10 | Why |
|---|---|---|---|
| cap/derive-analytical-model | capability | partial -> pass | With no footing in the roof truss, the old rule made every node at the lowest level a guessed support: all five nodes of the flat tie (two overhang tips, two heels, the king post foot). AxisVM's authored model supports only the two heels (#204 at x = -14.510, #233 at x = -8.206). The derivation now joins lowest-level nodes into runs along members lying flat at that level. A node bears where a member rises whose element is drawn down to the level or where a column derived before, a wall, a slab or a footing under it holds it, and a run bears only at such nodes when two or more of them hold it (not all on one line, unless the run is on that line too): the rafters (#158, #136) are drawn to z = 0. The king post (#112) is drawn from z = 0.15, the tie's top face, and only reaches the tie because the joint rule moves its foot 0.15 m down, so it rests on the tie. Any other run bears at every node, so one bearing never leaves a run a mechanism. The derived supports are now the two heels (2 of 2), and the overhang tips are reported as free ends. |

## Why the product, not the probe

The physical file has nine beams and one column and no footing, wall or pile, so the derivation has to guess. A support at each end of a 0.35 m tie overhang, and one under the king post, is not how a truss bears: the overhang tips carry nothing into the ground, and the tie spans between the heels. The probe compares support positions only, not restrained degrees of freedom, so its comparison was already fair; it is unchanged.

## Regression evidence

`packages/create/src/in-store/structural-derive-plan.test.ts` adds a synthetic king-post truss with the post drawn from the tie's top face (supports at the heels only, overhang tips are free ends; with the post drawn to the tie axis it bears too) and controls: a straight ground beam keeps all three columns standing on it, a mono-pitch truss with one rafter keeps both tie ends, an L of ground beams with two columns on one leg keeps every node, a grade beam end resting on a wall keeps its support (a wall 0.3 m under a wide, shallow beam does not count), a run end over a column derived before keeps its support, and a lone flat beam keeps both ends. `structural-derive-fixtures.test.ts` now expects 2 guessed supports at x = -14.510 and -8.206 on the AxisVM roof truss, and 3 free ends. The truss test and the fixture test fail on the old planner and pass on the new one. The control test passes on the old planner (it supported every lowest-level node); it fails on an intermediate version that kept only the two outermost bearings of a straight run, which matched the truss but dropped the middle column of the ground beam. The steel frame, E1--3 and grade-beam cases keep their counts. `scripts/structural-capability-probes.test.mjs` now expects the real derivation to pass with 2 derived supports, and that adding or removing one support does not pass.

## Known limit

No local geometry tells a truss post resting on a tie from a column drawn from a ground beam's top face: both are drawn above the level and moved down onto the run by the joint rule. In a run that two or more other bearings hold, such a column gets no guessed support, where main gave it one. Guessed supports stay flagged, and the viewer requires the user to acknowledge them before writing.
