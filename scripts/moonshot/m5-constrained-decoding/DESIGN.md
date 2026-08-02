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

<!-- Numeral provenance, added 2026-07-29 for the numeral gate
     (scripts/moonshot/ci/check-report-numerals.mjs). No figure in this document
     is changed; these comments record which numbers results.json /
     results-tier2.json emit and which they do not. -->
<!-- numeral-ok: +66.7 :: compile-rate margin in POINTS (percentage-point
     difference between two rates the artifact stores as fractions), computed in
     the sentence. -->
<!-- numeral-ok: 45, 300s :: operational totals of the tier-1 session, not exam
     results: 45 model calls including smoke tests, the T01 pilot and 3 calls
     lost to a killed run, and the 300 s per-call timeout the raw-IFC arm needed.
     The results JSON records per-task outcomes, not session bookkeeping. -->

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

# Tier-2 exam (2026-07-25)

Tier-1 ended in an honest SPLIT: 100 percent compile-by-construction, zero
quality margin over an informed one-shot, because Haiku aced all 12 briefs.
Tier-2 puts the margin claim to a real test, restructured mid-design after
a hostile G2 review of tier-1 raised five findings. How each was addressed:

## 1. Rubric headroom proven before the arm comparison

Tier-1's 1.000-1.000 tie was partly a ceiling artifact: criteria
transcribed brief numbers with 5 percent dead zones. Tier-2 criteria add:

- `tight` value criteria (full credit only within 1 percent, zero at 20)
  for area sums and ratios, where the arithmetic is the point;
- per-element identity checks (sorted `windowAreas`);
- placement-intent checks measured from per-type mesh boxes in the IFC
  frame (`m.boxes`, kernel.mjs): opening-overlap freedom, opening
  containment in a wall ("wall-membership"), column grid regularity,
  per-storey window distribution;
- an intent-fidelity factor over the emitted ops (fraction of ops honoring
  explicitly stated brief values) multiplied into quality.

Headroom probe (`run-tier2.mjs --headroom`): the same model prompted with
TRUNCATED_SPEC (op names + fields only - no conventions, no example),
scored under the unfiltered treatment. Result over 8 briefs: mean 0.847,
spread 0 to 1 (T2-07 0, T2-05 0.893, T2-09 0.917, T2-01 0.964, four
legitimate 1.0s). Mid-scale, so the rubric discriminates. The probe also
CAUGHT a live rubric gap: a truncated-spec sample hung a window 0.5 m past
the wall end and all AABB-derived criteria still scored 1.0 - the
openings-contained criterion was added in response and the probe re-scored
offline from saved transcripts (`--headroom --offline`, zero extra calls).
Honest caveats: about half the briefs are one-shottable even from a
truncated spec (Haiku infers the conventions), and the rubric deliberately
tolerates benign FORMAL violations the validator rejects (uppercase ids;
a window flush with the wall end violating only the 0.05 m margin) - it
measures built intent, not grammar compliance.

## 2. Validator rules held out of every prompt

Tier-1's biggest confound: DSL_SPEC serialized the exact fit rules the
validator enforces, so "informed baseline" and constrained arm were nearly
identical protocols. Tier-2 prompts use DSL_SPEC_TIER2: full syntax, field
semantics, coordinate conventions, numeric limits, one example - but the
following rules are withheld (HELD_OUT_RULES in tasks-tier2.mjs):

1. opening horizontal fit: along +- width/2 within [0.05, L - 0.05];
2. opening vertical fit: sill + height <= wallHeight - 0.05;
3. openings on one wall must not overlap;
4. wall axis: equal start/end z, length >= 0.3 m;
5. storeys need pairwise distinct elevations.

All arms are told undocumented rules exist and get the same infeasibility
protocol ("output {\"infeasible\": true, ...}; NEVER silently change a
stated value"). Only the constrained arm ever learns the rules' content -
through rejection messages. That is the M5 thesis made testable: the
kernel conveys unpromptable information.

## 3. Three budget-matched arms

- (a) `constrained`: the B2.3 loop (per-op grammar + kernel gate, bounded
  repair with the exact rejection message), repair cap 2, so at most 3
  calls per task.
- (b) `filtered`: best-of-k one-shots, validator used ONLY as a post-hoc
  filter/selector (lenient salvage; selection by strict validity, schema
  compile, fewest skips - never the task rubric). No feedback to the model.
- (c) `unfiltered`: the same k samples, no validator at all - ops kept if
  the compiler physically accepts them, selection by parse success and
  fewest compiler drops.

k = 3 = arm (a)'s call cap, so the baselines never get less budget than
(a) can use. Arms (b) and (c) share the same k raw samples: both are
post-hoc treatments, so a paired evaluation on common samples is
statistically stronger and halves the call cost. (a)-(b) isolates
error-message feedback vs validator-as-filter; (b)-(c) isolates the
validator itself. The paired (a)-(b) and (a)-(c) mean-quality differences
are reported with seeded-bootstrap 95 percent CIs (10k resamples over the
20 feasible tasks). Rubric-oracle best-of-k is reported separately as a
diagnostic upper bound and never drives selection.

## 4. Scale

23 briefs (20 feasible + 3 infeasible) instead of 12, per the review's
"more briefs at k=3 over fewer at high k". Families: packing traps where
naive even spacing violates the held-out overlap rule (T2-01/09/11/18),
computed glazing ratios (T2-02/12), boundary vertical fit (T2-03), area
budgets (T2-04/13), graded towers with per-storey differences
(T2-05/14/19), column grids at scale up to 54 ops (T2-06/15), facade+door
coupling (T2-07/16), properties at scale (T2-08/17), capstones
(T2-10/20). A selftest proves all 20 feasible briefs are satisfiable at
quality 1.0 via hand-written golden programs before any model call.

<!-- numeral-ok: 23 :: the tier-2 brief count (20 feasible + 3 infeasible), a
     property of the task set defined in tasks-tier2.mjs. results-tier2.json
     stores the per-task records, not their count. -->

## 5. Infeasible briefs and anti-laundering scoring

The tier-1 repair probe "converged" by silently rewriting the stated sill
- constraint laundering, previously scored a success. Tier-2: three
deliberately infeasible briefs. T2-F1 (10 m of window on an 8 m wall) and
T2-F2 (sill 1.0 + height 2.5 on a 3 m wall) are infeasible by plain
arithmetic - every arm CAN detect them from the prompt alone. T2-F3 (sill
1.1 + height 1.5 = exactly the 2.6 m wall height) is geometrically flush
but violates only the HELD-OUT head-clearance rule - detectable only
through kernel feedback. Scoring: a declared infeasibility = 1; anything
else = 0, with the laundered subclass (emitted ops contradicting stated
values) reported explicitly. Feasible tasks symmetrically score 0 for a
false infeasibility declaration, and their quality is multiplied by the
intent-fidelity factor so laundering can never buy score. Known asymmetry,
reported rather than hidden: the (b)/(c) selection keys have no signal for
preferring a declared-infeasible sample over any compiling program - a
best-of-k filter structurally suppresses infeasibility reports.

## Tier-2 results (measured 2026-07-25, model claude-haiku-4-5-20251001)

| Metric | (a) constrained | (b) filtered best-of-3 | (c) unfiltered best-of-3 |
|---|---|---|---|
| Mean quality, 20 feasible briefs | 1.000 | 0.992 | 1.000 |
| Mean quality, all 23 briefs | 1.000 | 0.906 | 0.913 |
| Compile OK (feasible) | 20/20 | 20/20 | 20/20 |
| Infeasible briefs correctly declared | 3/3 | 1/3 | 1/3 |
| Constraint laundering | 0 | 0 | 0 |
| False infeasibility declarations | 0 | 0 | 0 |
| Mean calls per task | 1.26 | 3 | (same samples as b) |

Paired margins over the 20 feasible briefs, bootstrap 95 percent CI (10k
resamples, seeded): (a)-(b) = +0.008 [0.000, 0.025]; (a)-(c) = 0.000
[0.000, 0.000]. Repair statistics: repairs fired on 6 of 23 tasks (5
feasible packing/margin traps: T2-01, T2-09, T2-11, T2-12, T2-18, plus
T2-F3), and recovered 6 of 6 - five to quality 1.0, T2-F3 to a correct
infeasibility declaration. Zero repair exhaustions. Kernel-as-judge
selection in (b)/(c) matched the rubric-oracle on every task (oracle mean
= selected mean). 115 model calls total for tier-2 (107 exam including a
killed-and-resumed chunk, 8 headroom probe), on top of tier-1's 45.

<!-- numeral-src: 1.000 :: none - arm-level MEAN QUALITY, and unbackable rather
     than merely unbacked: this is the 1.000 that arm (a) scores on the 20
     feasible briefs, arm (c) scores on the same 20, and arm (a) scores on all
     23, and no artifact in this tree holds it. Bound to `none` so a coincidental
     1.000 elsewhere in the union index cannot stand in as provenance. -->
<!-- numeral-ok: 0.992, 0.906, 0.913 :: the remaining arm-level mean qualities in
     the two quality rows of the table above. No artifact backs them: this table
     is RUN 1, and
     results-tier2.json now holds the replication's records instead (see
     "Tier-2 replication run" below, which states the overwrite). Run 1's
     per-task scores survive only as this table. -->
<!-- numeral-ok: 1.26 :: NOT a quality mean. It is arm (a)'s MEAN CALLS PER TASK
     in run 1, the last row of the same table, i.e. how often the repair loop
     fired on top of the one baseline call. Unbacked for the same reason: the
     comparable field in results-tier2.json is
     summary.constrained.meanCalls = 1.391, which is the REPLICATION's value and
     must not be read as this one. -->
<!-- numeral-ok: 115, 107 :: session bookkeeping again -- total model calls for
     tier-2 including a killed-and-resumed chunk and the headroom probe. Not exam
     results and not stored. -->

### Verdict, stated plainly

Does kernel-feedback decoding beat budget-matched informed sampling at
tier-2? On feasible-brief quality: NO. +0.008 vs the validator-filtered
baseline (CI touching zero, driven by a single task) and exactly 0.000 vs
the unfiltered baseline. On the full 23-brief set: YES, +0.094 (vs b) /
+0.087 (vs c) mean quality - but that margin comes ENTIRELY from
infeasibility handling (3/3 vs 1/3), not from feasible-brief quality.
Compile-by-construction held at 100 percent again, now with live repairs
(6 firings, 6 recoveries) rather than tier-1's zero.

Attribution within the infeasibility margin, honestly split:

- T2-F3 (hidden head-clearance rule): structurally attributable to kernel
  feedback. The constrained arm emitted the flush-fit window, the kernel
  rejected it with the exact rule, and the model correctly concluded
  infeasibility instead of laundering. No one-shot arm can do this even in
  principle - the rule is not in any prompt. This is the M5 thesis
  ("kernel conveys unpromptable information") demonstrated end to end.
- T2-F2 (arithmetically obvious): favored the constrained arm by sampling
  luck, and must not be claimed as a feedback win. Its single initial
  draw declared infeasibility; the three baseline draws all emitted
  programs. Same model, same prompt - 1 of 4 draws declared.
- T2-F1 (grossly obvious): all arms declared. No margin.

<!-- numeral-ok: +0.094, +0.087 :: the two paired margins over the full 23-brief
     set, i.e. differences of the arm means above. Computed here, not stored. -->

### What tier-2 actually taught

1. The held-out-rules design worked: Haiku violates the hidden margin
   rules regularly (repairs fired on 5 of the 8 packing/margin tasks),
   and the repair loop recovered every time, usually in one round.
2. But those violations are semantically BENIGN on an intent rubric:
   a window starting flush at the wall end violates the 0.05 m margin
   without harming any measured quantity, placement, containment or
   overlap criterion. The violations Haiku actually commits at this tier
   are boundary-hugging, not intent-destroying; overlapping or off-wall
   placements essentially never appear in informed samples. Hence (c)
   scoring a clean 1.000: with the compiler as the only gate, raw
   samples already realize the briefs' intent.
3. Validator-as-filter has NEGATIVE marginal value here (0.992 vs 1.000):
   on T2-09 it silently dropped all four margin-violating doors from the
   selected sample (doors = 0 in the emitted IFC), turning a benign
   violation into a missing-element failure. Filtering without feedback
   amputates; feedback repairs. That asymmetry - (a) 1.0 vs (b) 0.833 on
   T2-09 - is the cleanest per-task illustration of why the error message
   matters more than the gate.
4. The (b)/(c) selection keys structurally cannot prefer a declared
   infeasibility over any compiling program - best-of-k with a validity
   judge actively suppresses the correct answer on infeasible briefs.
   Fixing that would require the judge to know when declaring is right,
   which is precisely the knowledge only kernel feedback provides.
5. Harness defects the tier-2 process itself caught (all fixed and
   documented): the headroom probe exposed a rubric blind spot (a window
   hung 0.5 m past the wall end scored 1.0 - the openings-contained
   criterion was added and the probe re-scored offline); the mesh-frame
   fold for placement boxes needed IFC y = -mesh z (caught by the golden
   grid selftest); and a floating-point boundary rejection
   (0.7 - 0.65 < 0.05 in binary) punished a repair that followed the
   error message exactly - T2-18 initially EXHAUSTED because of it, the
   validator gained a 1e-9 epsilon, and T2-18 was rerun cleanly for all
   three arms (the pre-fix exhaustion is preserved in exam-run.log).

<!-- numeral-ok: 1e-9 :: the epsilon added to the validator's boundary
     comparison after the T2-18 floating-point rejection. A code constant, not a
     measurement. -->

### Implication for M5

Two tiers in, the pattern is consistent: the formal op vocabulary +
compiler + verifier delivers compile-by-construction and near-ceiling
quality regardless of decode-time machinery, and per-op kernel feedback
adds nothing measurable to feasible-brief quality at Haiku strength - the
proposer does not make intent-level errors often enough. What feedback
uniquely buys, on present evidence: (i) correct behavior at the
infeasibility boundary, where every feedback-free protocol either
launders, amputates, or emits broken programs; (ii) guaranteed recovery
when hidden rules do bite (6/6), where sampling merely makes recovery
probable. A wide QUALITY margin would need briefs whose constraint
interactions defeat 3 informed samples - at that point one-shot intent
realization, not rule compliance, has to be the failure mode - or a
weaker proposer. An honest summary is that M5's midterm "wide margin"
criterion, on the constrained-vs-informed axis, remains NOT MET for
feasible generation while being decisively met for constraint discovery
and infeasibility detection.

Artifacts: `results-tier2.json` (summary + per-task records + per-sample
detail + headroom section) next to this file; raw transcripts and IFC
under the session scratchpad `m5-tier2/` (`raw/`, `raw-headroom/`, `ifc/`,
`exam-run.log`).

### Tier-2 replication run (2026-07-25, orchestrator)

An accidental full second run (the orchestrator invoked the runner
believing `--offline` re-scored stored artifacts; that flag only affects
the headroom probe, so the exam re-ran live with 101 fresh Haiku calls)
turned into an independent replication with new samples. Its numbers now
occupy `results-tier2.json`; run 1's summary is preserved in the tables
above and its raw transcripts in the scratchpad.

Replication outcomes vs run 1:
- Infeasibility handling REPLICATED EXACTLY: constrained 3/3 correct
  declarations, both baselines 1/3 (2 emitted-partial each). Zero
  laundering, zero false declarations in both runs. This is the
  load-bearing M5 finding and it is now observed twice on independent
  samples.
- Feasible-quality null replicated in character: constrained 0.95 vs
  0.90/0.90 (run 1: 1.000 vs 0.992/1.000); margin +0.05, 95% CI
  [0, 0.15] straddling zero (run 1: +0.008 [0, 0.025] / 0.000). Neither
  run supports a reliable feasible-brief quality margin.
- New failure mode surfaced: constrained arm exhausted its repair cap on
  T2-10 and scored 0 (run 1: zero exhaustions). The cap-2 repair budget
  is not always sufficient; repair-budget sensitivity is an open knob.
- Run-to-run variance at n=20 with k=3 is visibly material (arm means
  moved by up to 0.10); any future margin claim needs the pre-registered
  CI discipline, not point estimates.
