# @ifc-lite/merge

Three-way merge engine for IFCX layers.

Built on two runs of the two-way comparison joined on entity identity, it
plans merges at **(entity, componentKey)** granularity: an architect
editing a wall's placement and an agent editing `Pset_FireSafety` on the
same wall is *not* a conflict.

```ts
import {
  planThreeWayMerge,
  applyResolutions,
  buildMergeLayer,
} from '@ifc-lite/merge';

// A = the candidate layer's base, O = the target ref's state,
// T = the candidate applied to A (all ordered weakest-first).
const plan = planThreeWayMerge({ ancestor, ours, theirs });
// plan.autoOps   — apply cleanly on top of `ours`
// plan.conflicts — explicit records: concurrent-edit, delete-vs-modify,
//                  modify-vs-delete, hierarchy

const { ops, resolutions } = applyResolutions(plan, [
  { path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' },
]);

const { file, layerId } = buildMergeLayer({
  ops: [...plan.autoOps, ...ops],
  author: { kind: 'human', principal: 'louis@example.com' },
  intent: 'Merge fire-safety reclassification into main',
  base: { kind: 'stack', id: stackHash },
  merge: { candidate, into: 'main', resolutions, resolver: 'louis@example.com' },
});
```

Also included:

- `extractStackState` — the "semantic reading" of a layer stack as
  per-entity component states (tombstones kept visible)
- `buildRevertLayer` — inverse-op layers (`[base, L, revert(L)]` composes
  back to `base`)
- `planRebase` — re-run the plan against a moved ref; prior resolutions
  replay automatically
- `opsToNodes` — serialize ops as ordinary IFCX node opinions

Spec: `docs/architecture/layer-prs/05-merge.md`. Part of the
[ifc-lite](https://github.com/LTplus-AG/ifc-lite) toolchain, MPL-2.0.
