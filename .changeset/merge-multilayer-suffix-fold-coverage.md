---
'@ifc-lite/merge': patch
---

Add test coverage pinning the multi-layer suffix fold in the merge fast path.

`projectSide` (`packages/merge/src/component-state.ts`) folds a side's
suffix layers weakest-first, per attribute — same contract documented on
`extractStackState`. That ordering was structurally unpinned: every
`ours`/`theirs` fixture in the suite was a suffix of length exactly 1, so
"earlier" never existed and the fold could not be observed. Reversing the
loop left all 94 existing tests green.

Adds:
- A hand-written fixture (`component-state.test.ts`) with a two-layer
  `ours` suffix that writes the same attribute in both layers (different
  values) plus an attribute written only in the earlier layer, proving
  shadowing is per-attribute rather than wholesale replacement, and
  carrying the fold-order-dependent value into an actual
  `planThreeWayMerge` conflict.
- A `layersPerSide` parameter on `fast-path-differential.test.ts`'s
  `scenario()` builder so the differential fuzz's fast-path-equals-
  reference proof also covers multi-layer suffixes, not only
  single-layer ones.

No production code changed; `projectSide`'s existing loop order is
correct (it already applies weakest-first) — only its test coverage was
missing. Confirmed by reversing the loop locally: the new tests fail
(RED) and the loop-order mutation at `component-state.ts:179`
(`extractStackState`'s equivalent fold) still fails the expected 40
tests across 8 files, confirming both mutation sites are exercised.

Also recorded, not fixed (out of scope for this patch):
- `merge-layer.ts:41-43` — `applyResolutions`'s `byKey` map uses
  last-insertion-wins with no test submitting two `ResolutionInput`s for
  the same `(path, componentKey)`; may be an undefined contract rather
  than a bug.
- `ref-flow.ts:109` — `checkRefPolicy`'s `requiredChecks` loop is only
  ever exercised with a single-entry array; which failing check is
  reported first with multiple failures is unpinned (message selection
  only).
