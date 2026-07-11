---
'@ifc-lite/ifcx': minor
'@ifc-lite/diff': minor
'@ifc-lite/extensions': minor
'@ifc-lite/mutations': minor
'@ifc-lite/collab': minor
'@ifc-lite/merge': minor
---

Layer PRs foundation (docs/architecture/layer-prs):

- **ifcx**: deletion-overlay tombstones (`ifclite::deleted`) with shadow/resurrect semantics and child-path shadowing in both composition engines; `bakeLayers` tombstone-free materialization; canonical serialization with blake3 content addressing (`computeLayerId`, `computeStackHash`); provenance manifest v1 (`createProvenanceManifest`, `getProvenance`/`setProvenance`, `validateProvenance`).
- **diff**: opt-in per-componentKey sub-hash mode (`buildComponentFingerprints`) and `changedComponents` on diff entries; the whole-blob `dataHash` default is unchanged.
- **extensions**: scope-claim grammar — capability expressions extended with entity selectors (`model.mutate:Pset_FireSafety*@IfcWall&storey=EG`), with grant-coverage and op-level enforcement matching.
- **mutations**: `changeSetToOps` expressId→GlobalId bridge with blake3 content-derived identity fallback recorded for the manifest `identity_map`.
- **collab**: `extractMinimalLayer` now expresses deletions (entity tombstones plus `null` removals), closing the documented additive-only deferral; new `publishLayer` freezes a draft into an immutable, content-addressed, provenance-stamped layer.
- **merge** (new package): three-way merge engine over (entity, componentKey) states with explicit conflict records, resolution application, merge-layer emission with `manifest.merge`, revert (inverse-op layers), and rebase.
