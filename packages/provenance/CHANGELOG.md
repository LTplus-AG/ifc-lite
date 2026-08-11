# @ifc-lite/provenance

## 0.1.1

### Patch Changes

- [#2332](https://github.com/LTplus-AG/ifc-lite/pull/2332) [`4e15665`](https://github.com/LTplus-AG/ifc-lite/commit/4e15665345eaab47b824e3fce9b4222595f1c26f) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `computeMergeOpFootprint` silently dropping the host/opening spatial coupling when a caller supplies its own `region` on an `entity-remove` or `geometry-replace` op.

  `entity-add`'s footprint already unions a caller-supplied `region` with the computed (host-aware) one ("union, never substitute" — a narrower override must never shrink the region below what the op actually touches). `entity-remove` and `geometry-replace` did not follow the same rule: any caller-supplied `region` replaced the computed region outright, discarding the hosted-openings/host-box coverage that makes the B4.2 spatial conflict rule catch the host-move-plus-opening-move pair that structurally looks disjoint but does not commute (recutHost reads live opening geometry under lazy cut semantics). A disjoint caller-supplied region on either op type let `conflictPredicate`/`findCrossConflicts` clear a pair that genuinely diverges.

  `createCommutationCertificate` was not compromised end-to-end by this — it always replays both op orders after the predicate passes and refuses on divergence — but `findCrossConflicts`/`conflictPredicate` used standalone (as `merge-battery.ts`'s own comments describe pairing with `attemptBothOrders` for ground truth) would return a false negative. Both op types now union the caller-supplied region with the computed one, matching `entity-add`.
