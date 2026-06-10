# 05: Diff and Merge Semantics

## 5.1 Engines

- `@ifc-lite/diff` (exists): two-way classification added/modified/deleted/unchanged over `EntityFingerprint`, scopes data/geometry/both
- `packages/merge` (new): three-way merge built on two runs of the two-way engine, plus conflict records and merge-layer emission

## 5.2 Per-component fingerprints (extension to `diff`)

`fingerprint.ts` gains an opt-in mode emitting sub-hashes per componentKey (02 §2.2): per-Pset, per-Qset, attribute groups, placement, type-assignment. The existing whole-blob `dataHash` remains the default (protected by current tests). Sub-hashes make the conflict unit (entity, componentKey): an architect editing placement and an agent editing `Pset_FireSafety` on the same wall is **not** a conflict.

## 5.3 Three-way algorithm

Inputs: ancestor A = candidate L's base, ours O = target ref's state, theirs T = L applied to A.

1. If `L.base == ref`, fast path: no three-way needed, conflicts are impossible, go to checks
2. Run diff(A→O) and diff(A→T); join on identity key; iterate the union of touched (entity, componentKey) pairs:

| A→O | A→T | Result |
|---|---|---|
| unchanged | changed | take theirs (auto) |
| changed | unchanged | keep ours (auto) |
| changed | changed, equal sub-hash | fold (auto) |
| changed | changed, different | **conflict: concurrent-edit** |
| tombstoned | changed | **conflict: delete-vs-modify** |
| changed | tombstoned | **conflict: modify-vs-delete** |
| tombstoned | tombstoned | fold (auto) |

3. Relations: same matrix over (relType, from, to) triples; reparenting one side while editing old containment on the other is **conflict: hierarchy** (taxonomy names reuse `collab/conflicts/detector.ts` kinds, lifted from session level to merge level)
4. Emit `MergePlan { autoOps, conflicts[] }`. Zero conflicts + green checks: merge can complete unattended (subject to ref policy, 10 §10.4)
5. Resolutions (ours/theirs/edited per conflict) are appended as ops; the result publishes as a **merge layer** with `manifest.merge` filled (03 §3.1). The candidate layer is never mutated; history is append-only

## 5.4 Rebase

State-based ops make rebase cheap: re-run §5.3 against the new base. Prior resolutions replay automatically (resolution ops shadow). No operational transform, ever.

## 5.5 Semantic checks as merge gates

After auto-merge (and after each resolution batch), checks run on the composed preview: IDS specs via `@ifc-lite/ids`, schema validity, optional clash via `@ifc-lite/clash` and `rust/clash`. A ref declares **required checks**; failures block merge unless explicitly waived (waiver recorded in the merge manifest with the waiving principal). This is branch protection for buildings.

## 5.6 Derived data rule

Merge reasons over data scope (P-tier) only. `DiffScope: 'geometry'` differences on derived components are not conflicts: invalidated derived components are recomputed post-merge (eagerly by the registry, lazily by viewers). "How do you merge two tessellations": you don't.

## 5.7 Performance budgets

- Three-way plan for two 50k-op layers over a 1M-entity model: < 1s (set algebra over hash maps; columnar store)
- Merge preview render in viewer: < 2s including sidecar-cached geometry
- These become public benchmarks alongside the parser numbers ("model merge in under a second, in the browser")

Measured (2026-06-10, M-series laptop, `pnpm --filter @ifc-lite/merge bench`, median of 3):

| entities | ops/side | plan time |
|---:|---:|---:|
| 10k | 1k | 17 ms |
| 100k | 10k | 84 ms |
| 1M | 50k | **635 ms** ✓ |

The budget is met by the prefix projection fast path: when ours/theirs extend the ancestor stack (the universal calling convention), only suffix-touched paths are folded and hashed — untouched entities share object references across all three states and short-circuit on reference equality. Tombstone-bearing stacks fall back to the reference full extraction (subtree shadowing is a global property); equivalence between the two paths is enforced by a differential fuzz suite. Extending the projection to tombstone-bearing stacks is a known follow-up.
