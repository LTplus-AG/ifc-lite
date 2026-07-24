# M5 constrained-decoding harness (bet B2.3, Phase 2 G2 exam)

Moonshot M5 ("the grounding compiler") midterm exam: neural front-ends emit
programs over the deterministic kernel, decoded under constraint with per-op
kernel feedback. Thesis under test: "neural proposes, kernel disposes".

Exam bar (docs/vision/moonshots-execution-plan.md, M5 midterm):

1. 100 percent of emitted programs compile by construction (invalid ops
   unreachable at decode time),
2. quality scored on the M2 benchmark machinery,
3. beats an unconstrained baseline of the same base model by a stated margin.

## Architecture

```
brief --> [neural proposer: claude -p, Haiku] --> op proposal (JSON)
              ^                                        |
              | repair re-prompt                       v
              | (validator/kernel error         [IFC-OPS grammar check]  dsl.mjs
              |  + applied-state summary)              |
              |                                        v
              +---------------------------- [kernel gate per op]        kernel.mjs
                                             compile prefix (@ifc-lite/create)
                                             parse + schema validate
                                             mesh + non-degenerate check
                                                       |
                                                       v
                                          accepted program --> IFC4 file
                                                       |
                                                       v
                                    [measure + score]  M2 checks (world-gym)
```

- `dsl.mjs` - IFC-OPS: a 9-op formal DSL (create_storey, create_slab,
  create_wall, add_window, add_door, create_column, create_beam,
  create_space, set_property) with a strict schema (exact field sets, typed
  ranges) and semantic rules over program state: unique ids, reference
  existence, wall-axis sanity, opening fit inside the host wall
  (horizontal + vertical margins), no overlapping openings.
- `compile.mjs` - 1:1 mapping of validated ops onto `@ifc-lite/create`
  (IfcCreator) producing real IFC4 STEP files.
- `kernel.mjs` - per-op kernel gate and final measurement. Reuses the M2
  World Gym check module (`tools/world-gym/lib/checks.mjs`) verbatim: the
  same in-process `computeValidationIssues` that `ifc-lite validate` runs,
  the same GeometryProcessor + clash engine. The gate compiles the accepted
  prefix, parses it back, schema-validates, meshes it, and confirms the new
  element produced non-degenerate geometry.
- `model.mjs` - the neural proposer: locally installed `claude` CLI in
  print mode, model `claude-haiku-4-5-20251001`, tools disabled, 1 turn, no
  session persistence, hard 120 s per-call timeout, global 120-call budget,
  every prompt/response persisted for audit.
- `tasks.mjs` - 12 briefs of graded difficulty (4 easy, 4 medium, 4 hard)
  with machine-checkable criteria, and the scoring rubric.
- `run-exam.mjs` - the two arms + aggregation. `--selftest` runs the whole
  non-neural pipeline (9-op golden program accepted and measured, 6 invalid
  ops rejected) with zero model calls.

## Constrained decoding protocol

Logit-level masking is unavailable over a CLI, so constraint is enforced by
proposal filtering with bounded repair - the harness, not the model, holds
the pen:

1. One initial full-program proposal per brief.
2. Ops are validated sequentially. Each op must pass (a) the IFC-OPS
   grammar + semantic validator and (b) the kernel gate (compile prefix,
   parse, schema-validate, mesh, new-element-has-geometry). Accepted ops are
   applied; everything after the first rejected op is discarded.
3. A rejected op triggers a repair re-prompt containing: the accepted
   prefix (as JSON), a kernel-derived applied-state summary (storeys, wall
   lengths/heights/opening counts), the rejected op, and the exact
   validator/kernel error. The model re-emits only the remaining ops.
4. Repair cap: 3 per task. On exhaustion the accepted prefix is emitted
   (still grammar-valid by construction) and the task is flagged
   `exhausted` - reported as a harness failure mode, not hidden.

"Compiles by construction" is literal: the emitted artifact is always the
compilation of a fully validated op sequence; no unvalidated model text can
reach the IFC file.

## Baseline arm

Same model, same initial prompt (identical DSL spec + brief - the baseline
is not handicapped by a worse prompt), single shot, no feedback. Lenient
compilation for quality scoring: markdown fences and surrounding prose are
stripped, the JSON array is extracted, invalid ops are skipped, and the
surviving ops are compiled. Strict compile = the response parsed as JSON
and every proposed op was grammar-valid. Both compile rates are reported.

## Scoring rubric

All measurements are taken from the compiled IFC bytes by an independent
reader (parse + kernel meshing), never from the op list:

- entity counts per IFC type (storeys, walls, slabs, columns, beams,
  windows, doors, spaces),
- plan extents from slab mesh AABBs, overall height from all meshes
  (the wasm mesher emits viewer-frame Y-up meshes; the harness folds mesh
  y back to IFC z - verified in the selftest),
- glazed area from window mesh AABBs, gross wall face area from wall mesh
  AABBs, room areas from space mesh AABBs,
- property criteria via EntityNode pset reads (e.g. Pset_WallCommon
  FireRating on every wall).

Criterion scores: counts score 1 if exact else `1 - |diff|/max(target,1)`
floored at 0; dimensions/areas score 1 within 5 percent relative error,
linearly to 0 at 50 percent. Task quality =
`gate * schemaFactor * clashFactor * mean(criteria)` with gate 0 when no
geometry meshed, schemaFactor 0 unless kernel validation reports zero
errors, and clashFactor `1/(1+clashes)` (the M2 clashScore channel; the
discipline matrix is architecture-blind, so this factor is usually 1 -
stated honestly rather than claimed as discriminative).

Determinism: everything except the model calls is deterministic (same
in-process kernel checks as M2, fixed task set, fixed prompts). Raw model
transcripts, per-task IFC artifacts and the run log are persisted under the
session scratchpad (`m5/raw`, `m5/ifc`, `m5/exam-run.log`); the aggregate
lives in `results.json` next to this file.

## Results (measured 2026-07-24, model claude-haiku-4-5-20251001)

Full per-task records in `results.json`; raw transcripts, IFC artifacts and
run logs under the session scratchpad (`m5/raw`, `m5/ifc`, `m5/*.log`).

| Metric | Constrained | Baseline (op DSL, one shot) | Baseline (raw IFC, one shot) |
|---|---|---|---|
| Compile rate | 12/12 = 100 percent | 12/12 = 100 percent | 4/12 = 33.3 percent |
| Mean quality (0-1) | 1.000 | 1.000 | 0.319 |
| Repairs / exhausted | 0 used, 0 exhausted | n/a | n/a |
| Model calls | 12 | 12 | 12 |

- Margin vs the op-DSL baseline: 0.000. Margin vs the raw-IFC baseline:
  +0.681 mean quality and +66.7 points of compile rate.
- 45 model calls total including smoke tests, the T01 pilot, 3 calls lost
  to a killed first raw-arm run (120 s timeout too tight for raw STEP
  emission; rerun at 300 s), and the repair probe - well inside the
  100-150 budget.
- Raw-IFC failure taxonomy: 7/12 produced zero meshable geometry (the
  hand-written representation graphs do not survive the kernel mesher),
  3/12 had schema validation errors, and even a "compiling" one (T11,
  0.833) lost its storey structure. Entity counts were often right while
  the geometry was unusable - exactly the mesh-soup failure M5 predicts.
- Repair-loop probe (adversarial brief with an impossible window, kept out
  of the exam aggregates): the model emitted the invalid op verbatim, the
  validator rejected it with the exact fit-rule error, one repair
  re-prompt converged to a compiling program (sill lowered 2.0 -> 1.55).
  The kernel-feedback loop demonstrably works end to end; the exam tasks
  simply never needed it.

## Honest reading vs the M5 midterm bar

- "100 percent of emitted programs compile by construction": PASS, and by
  design rather than luck - no unvalidated model text can reach an IFC
  file, and the live run confirmed 12/12 with zero repair exhaustions.
- "Beats an unconstrained baseline of the same base model by a wide,
  stated margin": SPLIT, and this is the honest headline. Against the
  raw-IFC baseline the margin is wide (+0.681 quality, 33.3 vs 100
  percent compile): the op-DSL + kernel compiler is worth a factor of ~3
  in quality on its own. But against the same model given the same DSL
  spec in one shot with NO feedback, the margin on this task set is ZERO -
  Haiku one-shots all 12 briefs. The constraint machinery contributed
  certainty (a guarantee instead of an observation), not measured quality,
  because the model never produced an invalid op when the grammar was in
  the prompt. The per-op kernel feedback loop is proven live only by the
  adversarial probe (1 rejection -> 1 repair -> convergence).
- Implication for M5: at this brief complexity, the valuable asset is the
  formal op vocabulary + compiler + verifier, not decode-time rejection;
  the feedback loop should start paying on briefs hard enough that
  one-shot fit-rule violations become common (the probe shows the
  mechanism is ready). A harder task tier - or a weaker/faster proposer -
  is the right next experiment before claiming the wide margin the exam
  asks for on the constrained-vs-informed-baseline axis.

Standing methodological notes, independent of the outcome:

- "Quality scored on the M2 benchmark" is satisfied partially by
  construction: scoring reuses the M2 check module (schema validity + clash
  are two of the five M2 reward channels) plus task-specific measured
  criteria; the determinism-hash and defect-detection channels do not apply
  to generation from briefs, and quantityAccuracy is replaced by
  AABB-derived measured quantities. This is "M2 machinery", not a frozen
  published M2 benchmark (which does not exist yet as an artifact).

Known shortcuts and open items:

- Per-op kernel feedback is proposal-filtering + repair, not logit masking;
  true decode-time unreachability of invalid ops needs sampler integration
  (the M6 "validator in the same wasm as the sampler" endgame).
- The clash factor is near-vacuous for architecture-only models (known M2
  limitation, same root cause as the World Gym footing rule note).
- Wall gross area from AABBs over-counts nothing for axis-aligned walls but
  would for oblique walls; the task set only pins ratios on axis-aligned
  facades.
- Baseline leniency (invalid ops skipped, fences stripped) turned out moot
  in the measured run: the op-DSL baseline never proposed an invalid op
  (skipped = 0 on all 12 tasks).
- The raw-IFC arm needed a 300 s per-call timeout (a full STEP file is
  thousands of output tokens); its first attempt at 120 s lost 3 calls to
  timeouts and was rerun. Slow emission is itself a real cost of the
  no-compiler path, but the reported raw-arm numbers are content failures,
  not timeout artifacts.
- Single model, single run per task; no variance estimate (budget-bound).
