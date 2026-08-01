# World Gym Benchmark - spec v1.1.0

The public benchmark face of the M2 World Gym (docs/vision/moonshots-execution-plan.md,
B2.2). One sentence: given procedurally generated IFC building models with
known-by-construction ground truth, score a system on detecting planted
defects, estimating quantities, and triaging models by severity - with the
answer key regenerable by anyone from seed arithmetic, and reference
baselines anchoring the leaderboard. That regenerability is the benchmark's
design premise and also, on the reporting split, its open integrity problem --
see section 1a before quoting a test score.

Version: `1.1.0` (`specVersion` in every submission and leaderboard row).
Any change to the constants, the generator's byte output, the task set, or
the scoring math bumps the version, and rows produced under versions that
differ in any of those are not numerically comparable. A version may also bump
without touching any of them, and v1.1.0 is exactly that case: it changes no
constant, no byte output, no task and no scoring math, only what the spec
claims a test row is worth - it withdraws a false integrity claim and states
the real one (section 1a). So comparability splits in two here, and the two
halves must not be conflated:

- **numerically comparable: yes.** Same seed universe, same bytes, same tasks,
  same scoring math, so a v1.0 score and a v1.1 score measure the same thing
  and may be read side by side.
- **comparable in trust: no.** A v1.0 *test* row was reported under a claimed
  integrity property that did not exist (section 1a); a v1.1 test row is
  reported as self-reported, with no integrity property claimed at all. The
  numbers line up; what they are worth does not, and no later version can
  retroactively give a v1.0 test row the trust its version asserted.

Dev rows are untouched by the second point: dev carried no integrity claim
under either version and still carries none.

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
of `../README.md`). We do not publish an answer-key file for any split,
because while the generator is unsalted - which is every split today, see
section 1a - such a file would be security theater: anyone can regenerate it.
Read "anyone can regenerate it" as scoped to that unsalted state. Once the
reporting split is salted its answer key stops being regenerable by anyone,
and it stays unpublished for the opposite reason: it is then held by the
hosted scorer and publishing it would destroy the property.

### 1a. Integrity model (v1.1). Read this before quoting a score.

**v1.0 claimed the test split was "hidden-by-hosting". That claim was false and
is withdrawn.** `attacks/clean-twin-diff.mjs` scores an exact **1.000 aggregate**
through the real scorer, above all three committed anchors, while reading only
`model.content` and touching no answer-key field. The attack is not a rule
violation; it is a consequence of the design:

- splits are defined by seed arithmetic alone (`seed % 10`), so **every test
  seed is public** - there is no seed list to withhold;
- `generateModel(seed, family, opts)` takes **no secret**, so anyone can
  regenerate any model;
- corruption is drawn from its own `${seed}:corrupt` RNG stream, independent of
  the family and param streams, so `corruptRate: 0` yields a byte-identical
  **clean twin** and a line diff isolates every planted defect exactly.

Hosting the episode bytes does not fix this, and it is worth being explicit
about why, because it is the intuitive fix: the attacker never needed the bytes.
Knowing the seed and owning the generator, they produce both twins locally. A
hosted server withholds only what is freely reconstructible.

**What actually closes it is a secret that enters generation.** v1.1 therefore
declares the reporting split's integrity model as *hidden-by-secret-salt,
delivered by hosting*, and the two halves are not alternatives:

1. a per-split salt, held only by the scoring service, mixed into **every** RNG
   stream - `family`, `params` and `corrupt`. Salting only the corruption stream
   is insufficient: the clean twin stays computable and diffs against the served
   bytes. The salt is rotatable per split, so a leak is a dated, recoverable
   event rather than a silent permanent one;
2. a hosted scorer to deliver the salted bytes, since a submitter who cannot
   regenerate the split must receive it. This is the same server B6.2 requires,
   not a second mechanism.

**Status, stated so no reader has to infer it: neither half is implemented.**
Until the scorer exists, the reporting split has *no* integrity property, test
rows are self-reported, and the leaderboard says so. `clean-twin-diff` stays
committed as a regression and the exam clause is that it scores at or below the
always-clean anchor on the reporting split - a clause that can only be run once
hosting exists.

- **dev is open and attackable by design.** Score yourself locally as often as
  you like (`score.mjs --split dev`). `clean-twin-diff` works on dev and will
  keep working; that is deliberate, and dev numbers carry no integrity claim
  whatsoever.
- **test is the reporting split.** Today: self-reported, no integrity property,
  see above. After the scorer: salted and server-side, the only channel that
  carries trust against an adversary.
- **train is where systems may learn**; training on dev/test seeds is
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
{"type":"header","benchmark":"ifc-lite-world-gym","specVersion":"1.1.0","split":"dev","name":"my-method","tasks":["defect-detection","quantity-estimation","validity-triage"]}
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
3. Report the spec version with every row. Rows never share a leaderboard
   across versions that differ in seed universe, byte output, task set or
   scoring math. v1.0 and v1.1 differ in none of those and are the one
   documented exception (see the version note at the top of this file) -
   which is why the committed anchor rows still read `1.0.0`. The integrity
   claim never carries across a version, exception or not.
4. Self-reported test rows must state "self-reported", and today every test
   row is one. The trusted channel is hosted scoring over a SALTED split
   (human track); it does not exist yet, and hosting without the salt would
   not be one - see section 1a.

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

The committed rows under `results/` carry `"specVersion": "1.0.0"` and keep
it. That is the version they were produced and scored under, and rewriting the
field would assert a scoring run that never happened. They remain the valid
anchors for a v1.1 number: the only non-comment change v1.1 makes to any file
under `benchmark/` is the `SPEC_VERSION` constant itself, so re-running
`baselines.mjs` emits the same values with `1.1.0` in that field. They are dev
rows, so nothing about the withdrawn test-split claim attaches to them.

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
