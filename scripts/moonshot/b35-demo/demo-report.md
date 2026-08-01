# B3.5 integrated compounding demo -- report

One command, five moonshots, one storyline: `node scripts/moonshot/b35-demo/run.mjs`.

Master seed: **20260724**. Every number in this report except the
clearly marked *Volatile* section at the bottom is a pure function of that
seed: rerun the command and the hashes, scores and counts reproduce exactly.

| Act | Story | Status | Headline |
|-----|-------|--------|----------|
| 1 BIRTH | world-gym births a seeded building; reward channels score it | ok | 548 entities, 5/5 reward channels = 1.0 |
| 2 PROOF | provenance certificate verified in a second process; tamper refused | ok | verified reading 52.6316% of 57 nodes; tamper caught=true |
| 3 SABOTAGE | planted defects hunted; benchmark oracle scores the detector | ok | spotlight 1/1 caught; macro-F1 0.857143 |
| 4 CONVERGENCE | certified auto-merge + blocked conflict + property battery | ok | 873/1000 auto-merged, 0 unsound; conflict blocked=true |
| 5 DESCENT | differentiable carbon descent, kernel-validated optimum | ok | carbon -58.5%, kernel rel dev 1.54e-7 |

## Act 1 -- BIRTH (M2 world-gym)

Seed 20260724 deterministically births an **office** building: 548
entities, 1 storey(s), 28004 bytes.

- model sha256: `80b58870ce12bc4f40bbd4da5ba7b5ce63dfdf7aa944bcc5774ce238898ab912` (regenerable from the seed alone)
- schema: valid=true (0 errors, 0 warnings); clashes: 0
- ground-truth totals (m3 / m2): slabCount=1, slabGrossArea=214.212816, slabGrossVolume=62.550142, wallCount=4, wallGrossSideArea=427.1124, wallGrossVolume=68.594251, partitionWallCount=6, roomCount=16, roomNetFloorArea=214.212816, roomNetVolume=617.361336
- reward channels: schemaValidity=1, clashScore=1, determinismHashMatch=1, quantityAccuracy=1, defectDetection=1

## Act 2 -- PROOF (M1 proof-carrying edit, the G0 story on a fresh model)

The parsed building becomes a 57-node node-hash-v0 DAG
(27 elements, 27 pset/qset leaves, 1 storey element(s),
1 storey containment relationship(s), 1 root).
One edit -- IfcWall #58 GrossVolume: 8.136439344000001 -> 9.136439344000001 --
yields a certificate carrying the changed path, the untouched sibling reads and a
subtree-untouched claim over 26 untouched sibling element subtree(s).

- root hash before: `sha256:3abc104a6b505c5c7574c8a032e91b9de2af528eeb69f29b78ad703bda0f41cc`
- root hash after:  `sha256:a4cfcd2b860dc7db4f7afef0234f43d92e2d5d5e7c3038703b9e3f00c84c5dff`
- second-process verification: ok=true, resolving 30/57 nodes (52.6316%)
  (single-storey building, so the claim is per sibling element; on multi-storey models the claim
  coarsens to whole storey subtrees and the verifier reads under 5% of the DAG -- the G0 gate shape)
- tampered copy (silent IfcSlab #41 mutation inside claimed-untouched territory): caught=true, reason: `hash-mismatch`

## Act 3 -- SABOTAGE + DETECTION (M2 corruption layer + B2.2 benchmark oracle)

Sibling seed 20260725 was force-corrupted; the corruption layer recorded
1 defect type(s) at plant time (ground truth by construction):

- planted: `{"type":"duplicate-globalid","guid":"1jaVXacz_tNbsfXb48C$nJ"}`

The real check pipeline detected: duplicate-globalid -- **1/1 caught**.

The same detector, scored by the benchmark's own oracle over the first 40
official dev-split seeds (17 corrupted; truth regenerated from seeds, no stored key):

- defect-detection macro-F1: **0.857143**
- quantity-estimation score: **0.94697**
- validity-triage score: **0.873166** over 477 cross-severity pairs (0.5 = uninformative)
- known blind spot, honestly priced in: `dangling-ref` is invisible to `ifc-lite validate` (per-type F1 0)

## Act 4 -- CONVERGENCE (M4/B2.1 commutation certificates)

The proven act-1 building (27 entities) becomes the shared base state,
Merkle root `sha256:19b941358ddb17af4f6198f5be7c079393c8faf470e7a8958819eae645423d62`.

- disjoint concurrent edits (alice: wall FireRating, bob: other element Status):
  certificate issued, both orders replay to merged root `sha256:17e853b04fd84c40368fba45eec0243f8ad98a94f0e26f476cc9ccf004f45059`;
  independent re-verification: ok=true
- colliding edits (both write the same wall pset): blocked=true, 1 conflicting cross pair(s) -- no certificate, no silent overwrite
- property battery (1000 schedules, seed 20260724): 873 auto-merged,
  **0 unsound auto-merges**, 127 flagged (12.70%),
  false-conflict rate 8.78% = 84 false / 957 ground-truth-COMMUTING
  schedules (the denominator the plan's < 20% kill criterion is defined over -- not the 127 flagged),
  certificates 873 issued / 34 verified / 0 failures;
  exam PASS, kill criterion PASS
  (the full decomposition, the spatial-restricted rate with its Wilson interval and the
  spatial-rule ablation live in `scripts/moonshot/g2-merge-soundness.mjs`, which runs the
  same battery at gate scale)

## Act 5 -- DESCENT (M3 differentiable carbon, kernel-validated)

Shortened penalty descent (6 rounds) over the diff-spike's 24-parameter
differentiable building with exact dual-number gradients:

- carbon: 177100.875 -> **73459.098 kgCO2e** (-58.521%); residual scaled constraint slack 0.00051128 across 4 constraint(s) (the full spike run drives this below 1e-6)
- optimum authored as IFC: 111197 bytes, 74 mapped elements, sha256 `48fc69e72d33c45002832dec38d53fc6d0c563bab997e8fafcdc537181078c4e`
- kernel re-meshed every element: worst volume rel dev 0.000001675 (wall-south-s0), missing meshes 0
- kernel-derived carbon 73459.109 kgCO2e, rel dev 1.54e-7 vs the parametric claim
- schema check on the optimum bytes: valid=true (0 errors, 1 warnings)

## Volatile (the ONLY non-deterministic block)

Wall clocks and the timestamp below change run to run; nothing above does.

- generated at: 2026-08-01T07:04:51.441Z (node v22.14.0)
- total wall clock: 6.8s
- per act: act1=0.0s, act2=0.1s, act3=0.3s, act4=2.6s, act5=3.8s
- artifacts (outside the repo): /var/folders/n2/jkb39p_x4md9jdv5hhzny6jc0000gn/T/ifc-lite-b35-demo

