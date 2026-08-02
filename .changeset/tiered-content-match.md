---
'@ifc-lite/diff': minor
---

**diff**: make `matchUnpairedByContent` work on models full of repeated components.

Unpaired entities were bucketed by (`ifcType`, `dataHash`) and paired only when a bucket held exactly one entity per side. A real model is mostly repeated components, so that paired only the unique minority: three data-identical doors at three different unmoved positions, all re-GUIDed by a re-export, landed in one bucket, reported a single `ambiguous` group, and pairs nothing at all.

Each bucket is now refined hierarchically from the inside. Geometry stays out of the *outer* bucket key on purpose — with it there, an element that genuinely moved would never meet its own previous revision and every real move would revert to add+delete noise.

- entities carrying a `geometryHash` are sub-bucketed by it. One per side, or the same count `N` on both sides, retires as `renamed`. `undefined` hashes are excluded: `undefined` agreeing with `undefined` is vacuous, not evidence.
- a 1:1 leftover pairs as `renamed`, `moved`, or the new `reshaped` kind.
- an N:M leftover is paired by iterated mutual nearest neighbour under a distance cap — a base and a head pair only when each is the other's *unique* nearest — which abstains by construction on a symmetric layout instead of guessing. The collision guard is part of that pairing test, so a pair it rejects stays in the candidate pool and the later rounds still see it. Groups above 128 per side report as `ambiguous`.

New API:

- `EntityFingerprint.aabb?: { min, max }` — optional world-space bounding box, both revisions in the same frame and units. It separates `moved` from `reshaped`, carries `ContentMatch.distance`, and enables the positional pairing above. Without it the pass degrades to the previous behaviour: `moved` for a 1:1 leftover, `ambiguous` for a group.
- `ContentMatchKind` gains `'reshaped'` — the bounding boxes changed size, or agreed entirely while the geometry hash changed (a re-tessellation). An axis-aligned box cannot separate a re-tessellation from a reshape confined to the interior, and this does not pretend it can.
- `ContentMatch.distance?: number` — centre displacement in the caller's units, clamped to `0` below `moveTolerance`.
- `DiffOptions.moveTolerance` (default `2e-3`), `reshapeTolerance` (default `1e-3`), `maxMoveDistance` (default `10`). The two tolerances are lifted from `MOVE_EPS`/`RESHAPE_EPS` in the viewer's `describeChange.ts`, which encode issue #1197 (a phantom "moved 1.09 m" on a wall that never moved).

Also fixed, in **both** matching passes: when one revision was fingerprinted by a build that produces geometry hashes and the other by a build that does not, every one-sided `undefined` read as "the geometry differs". The content pass reported the whole model as `moved`; the key-based pass reported every key-matched entity as `modified` with `changeKinds: ['geometry']`, so two revisions that may be identical read as a wholly changed model. Neither pass now uses geometry to classify anything in that case — a capability difference between two fingerprinting runs is not a model change. Both derive the decision from one shared helper so they cannot drift apart. The abstention needs a *whole side* to carry no hashes: with both sides hashing, a single entity gaining or losing geometry is still a real change and is still reported, and `excludeTypes` is applied before the scan so a dropped entity is not evidence that its side hashes.

**`DiffCounts` changes for that previously broken case, and only for it.** A mixed-capability comparison that used to return every matched entity as `modified`/`['geometry']` now returns them as `unchanged` (or `modified` on data alone under `scope: 'both'`/`'data'`): `counts.modified` falls and `counts.unchanged` rises by the same number. This is a false positive being replaced with the truth, not a lost signal, and it applies whether or not `matchUnpairedByContent` is set. The cost is the mirror case: a base revision that genuinely carries no geometry at all, compared against a head that added geometry to everything, is indistinguishable from a capability difference and now reports `unchanged`. `DiffState` and `DiffEntry` are unchanged in shape.

Behaviour change for existing callers of `matchUnpairedByContent`: a bucket with `N` entities per side that agree on both the data hash and the world geometry hash now retires as one `renamed` match carrying all `N` per side, where it previously reported an `ambiguous` group and retired nothing. `renamed` therefore no longer implies exactly one entity per side; `moved`/`reshaped` still do. `DiffState`, `DiffEntry`, and `DiffCounts` are unchanged, so exhaustive switches over `DiffState` keep compiling.
