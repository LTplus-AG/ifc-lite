# World Gym Benchmark - spec v1.0.0

The public benchmark face of the M2 World Gym (docs/vision/moonshots-execution-plan.md,
B2.2). One sentence: given procedurally generated IFC building models with
known-by-construction ground truth, score a system on detecting planted
defects, estimating quantities, and triaging models by severity - with the
answer key regenerable by anyone from seed arithmetic, and reference
baselines anchoring the leaderboard.

Version: `1.0.0` (`specVersion` in every submission and leaderboard row).
Any change to the constants, the generator's byte output, the task set, or
the scoring math bumps the version; rows across versions are not comparable.

## 1. Model universe and splits

The benchmark is exactly seeds `0..9999` of the World Gym generator
(`tools/world-gym/generator.mjs`), family `auto`, corruption rate `0.3`:

```js
generateModel(seed, 'auto', { corruptRate: 0.3 })  // byte-deterministic
```

Splits are defined by seed arithmetic, nothing else:

| Split | Rule | Size |
|---|---|---|
| train | `seed % 10 <= 7` | 8,000 |
| dev   | `seed % 10 == 8` | 1,000 |
| test  | `seed % 10 == 9` | 1,000 |

There is no dataset download. A model, its bytes, its planted defects, its
quantities - all are pure functions of the seed (see the determinism section
of `../README.md`). **Test labels are regenerable-by-seed, not distributed:**
we do not publish an answer-key file for any split, because with an open
generator such a file would be security theater - anyone can regenerate it.
The test split's integrity model is therefore explicitly *hidden-by-hosting*,
not hidden-by-secrecy:

- dev is the public iteration split: score yourself locally as often as you
  like (`score.mjs --split dev`).
- test is the reporting split: honest actors run `score.mjs --split test`
  once and report; a hosted leaderboard (human track, not yet live) scores
  test submissions server-side and is the only test channel that carries
  trust against adversaries. Until it exists, test rows are self-reported and
  the leaderboard says so.
- train is where systems may learn; training on dev/test seeds is
  contamination and disqualifies a row (enforceable only for hosted rows).

## 2. Tasks

All three tasks read the same input (the model bytes for a seed, which the
submitter regenerates locally or receives from the episode server) and are
scored against generation-time ground truth - never against any checker's
output, so no checker bug can leak into the answer key.

### 2.1 defect-detection

Per model, a boolean verdict for each of the 7 defect types
(`clash-pair`, `degenerate-geometry`, `duplicate-globalid`, `missing-site`,
`multiple-project`, `dangling-ref`, `missing-quantities`). Ground truth is
the corruption layer's plant-time records. Clean models have all-false truth.

Score: **macro-F1** over the 7 types. Per type, F1 = 2TP/(2TP+FP+FN) over
all models of the split; a type with TP+FP+FN = 0 scores 1. Task score =
mean of the 7 per-type F1 values. (The always-clean baseline scores 0 here
by construction: it never produces a true positive.)

### 2.2 quantity-estimation

Per model, predict 5 quantity totals in metric units:
`wallGrossVolume`, `slabGrossVolume`, `columnGrossVolume`,
`beamGrossVolume` (m3), `roomNetFloorArea` (m2). Ground truth is the exact
numbers used to author the geometry (the kernel quantities), NOT what
survives in the file - the `missing-quantities` defect deletes bindings from
the bytes, but the geometry still has those volumes and a system that meshes
the file can recover them.

Score: per model, over the keys whose truth is > 0 (families do not share
all keys - `office` has no columns/beams, `frame` has no rooms; predict 0
for non-applicable keys, they are never scored):
`mean_k max(0, 1 - |pred - truth| / truth)`; task score = mean over models.

### 2.3 validity-triage

Per model, one real number: higher = more defective. Ground truth severity
is ordinal: the number of distinct planted defect types (0 clean, 1-3
corrupted). Score: **concordance index** - over all model pairs with
different truth severity, count 1 when the predicted ordering agrees, 0.5
when the predictions tie, 0 otherwise; task score = mean. 0.5 is
uninformative, 1 is a perfect ranking.

### Aggregate

Unweighted mean of the three task scores. Reported only for submissions
covering all three tasks; partial submissions get per-task scores and a
null aggregate.

## 3. Submission format

One JSONL file. First line is a header, then one line per seed of the split
(any order, every seed exactly once):

```jsonl
{"type":"header","benchmark":"ifc-lite-world-gym","specVersion":"1.0.0","split":"dev","name":"my-method","tasks":["defect-detection","quantity-estimation","validity-triage"]}
{"seed":8,"defects":{"clash-pair":false,"degenerate-geometry":false,"duplicate-globalid":false,"missing-site":false,"multiple-project":false,"dangling-ref":false,"missing-quantities":false},"quantities":{"wallGrossVolume":44.7,"slabGrossVolume":35.2,"columnGrossVolume":0,"beamGrossVolume":0,"roomNetFloorArea":122.1},"triage":0}
```

`tasks` may be any non-empty subset; each model line must carry exactly the
fields the declared tasks need (`defects` with all 7 booleans / `quantities`
with all 5 non-negative finite numbers / `triage` finite number).

Validate and score:

```bash
node tools/world-gym/benchmark/score.mjs --submission sub.jsonl --split dev --validate-only
node tools/world-gym/benchmark/score.mjs --submission sub.jsonl --split dev --out row.json
```

The scorer regenerates ground truth from seeds on every run (dev: ~1,000
generations, seconds) and emits a deterministic leaderboard-row JSON - same
submission in, byte-identical row out.

## 4. Rules

1. Systems may use anything at inference time EXCEPT the corruption layer's
   plant records or the generator's internal ground truth for the evaluated
   seed (i.e. you may read/mesh/analyze the model bytes; you may not call
   `generateModel` on the evaluated seed and read `model.defects` - that is
   the answer key). Running ifc-lite's own checks is allowed - that is what
   the `oracle-kernel` baseline does, and beating it is the point.
2. Training/tuning on `train` seeds is expected; any use of dev/test seed
   ground truth during training is contamination.
3. Report the spec version with every row. Rows across versions never share
   a leaderboard.
4. Self-reported test rows must state "self-reported"; hosted scoring
   (human track) is the trusted channel.

## 5. Reference baselines (leaderboard anchors)

`baselines.mjs` produces three rows, committed under `results/`, that make
external numbers interpretable:

- **always-clean**: no defects, zero quantities, constant triage. The floor.
- **heuristic-text**: cheap text/structural signals only (entity counts,
  duplicate-GUID scan, reference-integrity scan, depth-0 extrusion scan,
  qset-binding ratio check, regex harvest of embedded quantity values). No
  geometry kernel, no schema engine.
- **oracle-kernel**: the kernel's own in-process schema/clash/quantity
  checks mapped to verdicts - the oracle-ish upper bound.

Two honest and load-bearing observations from the dev-split anchors
(numbers in `results/leaderboard-dev.json`):

1. **heuristic-text outscores oracle-kernel on defect-detection.** The v1
   corruption layer plants mostly text-level defects, and one of them
   (`dangling-ref`) is invisible to the kernel's validate while being
   trivial for a reference-integrity text scan. Consequences: (a) the
   defect-detection task is near-saturated by pattern-matching for THIS
   corpus version - external submissions should be read primarily on
   quantity-estimation (where geometry understanding is required to beat
   text harvesting on corrupted models) and on robustness/generalization;
   (b) spec v1.1 should add geometric/organic defect families (element
   misalignment, unit-scale errors, off-by-storey placement) that text scans
   cannot see, plus a validate reference-integrity rule upstream.
2. **Neither baseline reaches 1.0 on quantity-estimation.** Both read the
   quantity values embedded in the bytes, so both lose exactly the truth
   that `missing-quantities` models withhold; recovering it requires actual
   geometry reasoning. That gap is deliberate headroom.

## 6. Episode access for RL-style consumers

`ifc-lite gym --seed <n>` serves benchmark episodes over the existing
reset/step/reward JSONL protocol without the consumer touching generator
internals; mid-session `{"type":"reset","seed":<n>}` swaps to a new episode.
See `../README.md` ("Benchmark quickstart") and `ifc-lite help` for the
protocol.

## 7. Files

```text
benchmark/
  BENCHMARK.md        this spec (versioned)
  splits.mjs          constants + split arithmetic (the normative universe)
  ground-truth.mjs    per-seed answer-key regeneration (generation-time labels only)
  submission.mjs      submission JSONL parser + validator
  score.mjs           scoring harness CLI (per-task + aggregate + row emission)
  baselines.mjs       the three reference baselines (submission round-trip incl. validator)
  results/            committed anchor rows + split summaries (small JSONs)
```
