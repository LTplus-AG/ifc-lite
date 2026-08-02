# B3.5 integrated compounding demo -- report

One command, five moonshots, one storyline: `node scripts/moonshot/b35-demo/run.mjs`.

Master seed: **20260724**. Every number in this report except the
clearly marked *Volatile* section at the bottom is a pure function of that
seed: rerun the command and the hashes, scores and counts reproduce exactly.

| Act | Story | Status | Headline |
|-----|-------|--------|----------|
| 1 BIRTH | world-gym births a seeded building; reward channels score it | ok | 548 entities, 5/5 reward channels = 1.0 |
| 2 PROOF | provenance certificate verified in a second process; tamper refused | ok | verified reading 53.5714% of 56 nodes; tamper caught=true |
| 3 SABOTAGE | planted defects hunted; benchmark oracle scores the detector | ok | spotlight 1/1 caught; macro-F1 0.857143 |
| 4 CONVERGENCE | certified auto-merge + blocked conflict + property battery | ok | 849/1000 auto-merged, 0 unsound; conflict blocked=true |
| 5 DESCENT | differentiable carbon descent, kernel-validated optimum | ok | carbon -58.5%, kernel rel dev 1.54e-7 |

## Act 1 -- BIRTH (M2 world-gym)

Seed 20260724 deterministically births an **office** building: 548
entities, 1 storey(s), 28004 bytes.

- model sha256: `80b58870ce12bc4f40bbd4da5ba7b5ce63dfdf7aa944bcc5774ce238898ab912` (regenerable from the seed alone)
- schema: valid=true (0 errors, 0 warnings); clashes: 0
- ground-truth totals (m3 / m2): slabCount=1, slabGrossArea=214.212816, slabGrossVolume=62.550142, wallCount=4, wallGrossSideArea=427.1124, wallGrossVolume=68.594251, partitionWallCount=6, roomCount=16, roomNetFloorArea=214.212816, roomNetVolume=617.361336
- reward channels: schemaValidity=1, clashScore=1, determinismHashMatch=1, quantityAccuracy=1, defectDetection=1

## Act 2 -- PROOF (M1 proof-carrying edit, the G0 story on a fresh model)

The parsed building becomes a 56-node node-hash-v0 DAG
(27 elements, 27 pset/qset leaves, 1 storeys, 1 root).
One edit -- IfcWall #58 GrossVolume: 8.136439344000001 -> 9.136439344000001 --
yields a certificate carrying the changed path, the untouched sibling reads and a
subtree-untouched claim over 26 untouched sibling element subtree(s).

- root hash before: `sha256:771cb465932d61e5607a251de8af33a35e721a4eac442787f9974ede79105f0d`
- root hash after:  `sha256:aa00d60d3f10503c221f09d61b141577fdfac1b8cf012de9ecc7df7f4b170012`
- second-process verification: ok=true, resolving 30/56 nodes (53.5714%)
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
Merkle root `sha256:1d335793b20bc580ce16ba7eafbb3a0a9c48b0786a9e0444cff42eba58c52ebc`.

- disjoint concurrent edits (alice: wall FireRating, bob: other element Status):
  certificate issued, both orders replay to merged root `sha256:bff4e3213591febc02e084fdbaf4cc84fadd4ae5382748535d685247bb9cf4ed`;
  independent re-verification: ok=true
- colliding edits (both write the same wall pset): blocked=true, 1 conflicting cross pair(s) -- no certificate, no silent overwrite
- property battery (1000 schedules, seed 20260724): 849 auto-merged,
  **0 unsound auto-merges**, 151 flagged (15.10%),
  false-conflict rate 10.63%, certificates 849 issued / 33 verified / 0 failures;
  exam PASS, kill criterion PASS

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

- generated at: 2026-07-24T22:30:09.456Z (node v22.14.0)
- total wall clock: 7.5s
- per act: act1=0.0s, act2=0.1s, act3=0.3s, act4=1.9s, act5=5.3s
- artifacts (outside the repo): /var/folders/n2/jkb39p_x4md9jdv5hhzny6jc0000gn/T/ifc-lite-b35-demo

