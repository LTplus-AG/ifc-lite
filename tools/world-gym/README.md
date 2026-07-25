# World Gym - procedural building generator + deterministic labeler + benchmark

M2 (docs/vision/moonshots-execution-plan.md): a procedural generator +
deterministic labeling pipeline over `packages/create`, now at the M2
midterm bar - **100k generated models, 100% labeled, mixed positive and
negative label classes, labels spot-validated against the IfcOpenShell
differential oracle, five discriminative reward channels behind one env
API** - plus, since B2.2, a **versioned public benchmark**
(`benchmark/BENCHMARK.md`): three scored tasks over a 10k-seed universe with
deterministic train/dev/test splits, a submission validator + scoring
harness, three committed reference baselines, and benchmark episodes served
through `ifc-lite gym --seed <n>`.

Every sample gets perfect ground-truth labels because the labels are either
the exact numbers used to author the geometry (not re-derived from the
file), the exact defects planted by the corruption layer (recorded at plant
time, independent of any checker), or the output of actually running the
kernel's own checks on the serialized bytes.

## Quick start

```bash
# One model, standalone
node generator.mjs --seed 42 --family frame --out /tmp/model.ifc --json

# One adversarial model with known-by-construction defects
node generator.mjs --seed 42 --corrupt --out /tmp/bad.ifc --json

# One model, generated + labeled in-process (writes the file, prints one JSONL line)
node labeler.mjs --seed 42 --family frame --model-dir /tmp/world-gym

# Determinism proof over 20 seeds
node determinism-check.mjs --seeds 20

# A corpus run (output MUST go outside the repo). 30% adversarial, no .ifc
# files kept (every model is reproducible from its seed; the manifest is
# the deliverable):
node run-pilot.mjs --count 100000 --out-dir /path/outside/repo/wg-100k \
  --corrupt-rate 0.3 --no-keep-files --workers 10

# Reward-channel discrimination report over a labeled corpus
node channel-report.mjs --manifest /path/wg-100k/manifest.jsonl --out channels-report.json

# IfcOpenShell differential oracle spot-validation (needs a python with
# ifcopenshell==0.8.5, the same pin as tools/ifcopenshell_reference)
node oracle-validate.mjs --manifest /path/wg-100k/manifest.jsonl \
  --python /path/to/venv/bin/python --every 500
```

## Benchmark quickstart (B2.2)

The benchmark is seeds 0..9999 at corrupt rate 0.3, split by seed
arithmetic: train `seed % 10 <= 7` (8,000), dev `seed % 10 == 8` (1,000),
test `seed % 10 == 9` (1,000). Three tasks, each scored 0-1: defect
detection (macro-F1 over the 7 planted defect types), quantity estimation
(1 - relative error vs the authoring-time kernel quantities), validity
triage (concordance of a severity ranking); aggregate = unweighted mean.
`benchmark/BENCHMARK.md` is the normative spec.

```bash
# Regenerate any benchmark model (same call the episode server makes)
node generator.mjs --seed 4218 --corrupt-rate 0.3 --out /tmp/m.ifc

# Validate a submission (JSONL: header line + one prediction line per seed)
node benchmark/score.mjs --submission sub.jsonl --split dev --validate-only

# Score it: regenerates the split's ground truth from seeds (~1s for dev),
# emits a deterministic leaderboard-row JSON
node benchmark/score.mjs --submission sub.jsonl --split dev --out row.json

# Re-run the three reference baselines (submissions land outside the repo,
# rows + split summary in benchmark/results/)
node benchmark/baselines.mjs --split dev --out-dir /path/outside/repo/wg-bench

# Serve benchmark episodes over the gym protocol (RL-style consumers);
# mid-session {"type":"reset","seed":N} swaps episodes
node ../../packages/cli/dist/index.js gym --seed 42 --checks schema,clash
```

Submission how-to, in three steps: (1) for every seed of your split,
obtain the model (regenerate locally, or stream episodes via `ifc-lite gym
--seed N`) and produce per-model predictions; (2) write the JSONL file -
header `{"type":"header","benchmark":"ifc-lite-world-gym","specVersion":
"1.0.0","split":"dev","name":"<your-method>","tasks":[...]}` then one
`{"seed":8,"defects":{...},"quantities":{...},"triage":0.7}` line per seed;
(3) run `score.mjs` as above. The only rule that matters locally: reading
`generateModel(...).defects`/`labels` for an evaluated seed is reading the
answer key (see BENCHMARK.md rules). Dev-split anchor rows to beat are in
`benchmark/results/leaderboard-dev.json`.

`--family` accepts `frame`, `office`, or `auto` (default - the seed itself
picks the family, so `--seed N` alone still determines one specific building
end to end).

## Architecture

```text
tools/world-gym/
  lib/
    rng.mjs                   deterministic seeded PRNG (mulberry32 + FNV-1a seed hash)
    deterministic-runtime.mjs shim that pins Date/crypto.randomUUID for one build (see Gaps)
    quantities.mjs            wall/slab/column/beam/space quantity math, shared by both families
    corruption.mjs            adversarial defect planner + injector (negative-label half)
    checks.mjs                in-process schema/clash/quantity checks (warm WASM per worker)
    reward-channels.mjs       the five reward channels behind one env API
  families/
    frame.mjs                 Family A: multi-storey slab-and-column frame
    office.mjs                Family B: single-storey partitioned office slab
  generator.mjs                generateModel(seed, family, {corruptRate|forceCorrupt}) -> model; CLI wrapper
  labeler.mjs                   labelModel(model, filePath) -> manifest line; CLI wrapper
  worker.mjs                    per-model worker: generate + (write) + label, over IPC
  run-pilot.mjs                 worker-pool orchestrator: N models, dedup, timing, summary.json
  determinism-check.mjs         byte-identical proof over N seeds
  channel-report.mjs            per-channel value distributions over a corpus manifest
  oracle-validate.mjs           samples + regenerates models, drives the python oracle
  oracle_validate.py            IfcOpenShell 0.8.5 differential checks per sampled model
  benchmark/
    BENCHMARK.md                the versioned benchmark spec (tasks, splits, rules, scoring)
    splits.mjs                  constants + seed-arithmetic splits (normative universe)
    ground-truth.mjs            per-seed answer-key regeneration (generation labels only)
    submission.mjs              submission JSONL parser + validator
    score.mjs                   scoring harness CLI (per-task + aggregate + leaderboard row)
    baselines.mjs               always-clean / heuristic-text / oracle-kernel anchors
    results/                    committed anchor rows + split summaries (small JSONs)
```

`generateModel()` is the single source of truth. It:

1. Derives a family choice (`{seed}:family` sub-stream), a parameter draw
   (`{seed}:params:{family}` sub-stream), and a corruption decision + defect
   plan (`{seed}:corrupt` sub-stream) from independent RNG streams keyed off
   the seed.
2. Builds the model into one `IfcCreator` instance using the exact same
   `@ifc-lite/create` methods the CLI's `ifc-lite create` command calls -
   metres, identity placement, one `toIfc()` call, per house convention.
3. If the seed is corrupted: applies build-time defects (overlapping footing
   pairs, zero-height columns) before `toIfc()` and text-level defects
   (GUID duplication, deleted IfcSite, duplicated IfcProject, dangling ref,
   deleted quantity bindings) after it - all drawn from the seed, all
   recorded as ground truth at plant time.
4. Wraps the build + `toIfc()` in `withDeterministicRuntime(seed, fn)`.

## Family parameter spaces

### Family A - `frame` (rectangular multi-storey slab-and-column frame)

Perimeter walls with generic rectangular openings cut (never filled by a
door/window) ring every storey; a column grid sits at every bay
intersection; beams tie the grid together at the top of each storey; a slab
floors every level plus one roof slab on top.

| Parameter | Range | Notes |
|---|---|---|
| `storeys` | 1-4 (int) | |
| `storeyHeight` | 2.7-3.9 m | |
| `baysX`, `baysY` | 2-4, 2-3 (int) | grid bay counts |
| `spanX`, `spanY` | 3.0-7.5 m, 3.0-6.5 m | bay spans |
| `wallThickness` | 0.15-0.30 m | |
| `slabThickness` | 0.18-0.32 m | |
| `columnSize` | 0.25-0.45 m | square cross-section |
| `beamWidth` / `beamHeight` | 0.2-0.35 m / 0.3-0.5 m | |
| `openingsPerLongWall` | 0-3 (int) | cut into the two longer perimeter walls only |
| `openingWidth` / `openingHeight` / `sillHeight` | 1.0-1.8 / 1.2-1.8 / 0.8-1.0 m | |

### Family B - `office` (single-storey partitioned office slab)

One floor slab, a perimeter wall ring, and a lattice of partition walls
carving the footprint into a `rows x cols` grid of rooms, each captured as an
`IfcSpace`.

| Parameter | Range | Notes |
|---|---|---|
| `rows`, `cols` | 2-4, 2-5 (int) | room grid |
| `roomSpanX`, `roomSpanY` | 3.0-6.0 m, 3.0-5.5 m | |
| `wallHeight` | 2.7-3.6 m | |
| `perimeterThickness` / `partitionThickness` | 0.2-0.35 / 0.1-0.15 m | |
| `slabThickness` | 0.15-0.30 m | |

Room footprints use the grid centerline, not partition-half-thickness
subtraction - a documented v1 approximation, good enough for reward-channel
ground truth.

### Adversarial mode (negative-label corpus half)

`--corrupt-rate p` corrupts a deterministic Bernoulli(p) subset of seeds
(`--corrupt` forces one model). Each corrupted model carries 1-3 distinct
defect types drawn from the `{seed}:corrupt` stream:

| Defect | Mechanism | Detected by |
|---|---|---|
| `clash-pair` | 1-3 pairs of overlapping `IfcFooting` at isolated positions, penetration 0.3-0.7 m, known pair names | clash engine (footing self-clash rule) |
| `degenerate-geometry` | 1-2 zero-height `IfcColumn` (extrusion depth 0) | geometry pipeline emits no mesh for them |
| `duplicate-globalid` | second wall's GlobalId overwritten with the first's | `validate` unique-globalid (error) |
| `missing-site` | `IFCSITE` line deleted (leaves a dangling aggregate ref too) | `validate` required-entity (error) |
| `multiple-project` | `IFCPROJECT` line duplicated under a fresh express id | `validate` single-project (error) |
| `dangling-ref` | one containment ref rewritten to `#99999999` | **nothing today** - see Known gaps |
| `missing-quantities` | 1-3 quantity-binding rel lines deleted | `validate` quantity-completeness + quantity re-extraction |

Ground truth for every planted defect is recorded in the manifest
(`defects` = what was planted, `expected` = what a correct checker must
observe) at plant time, independent of the labeler - so the labeler is
*validated against the plants*, never against itself. The 100k run's
`groundTruthAgreement` was 100,000/100,000 (`allMatchRate: 1`).

Corruption is exactly as deterministic as generation: same seed in, same
defects, same bytes out (verified byte-identical across repeated runs; the
Bernoulli roll is always burned before the plan draw so `--corrupt-rate`
corpora and `forceCorrupt` regeneration produce identical bytes).

## Label sources ("perfect ground truth", three kinds)

1. **Generation-parameter ground truth (free, exact, cannot drift).**
   `entityCountsByType` from `IfcCreator`'s own bookkeeping; storey count
   and every quantity from the family module's `build()` return value
   (`lib/quantities.mjs` computes each element's numbers once, feeds both
   the STEP output and the label).
2. **Planted-defect ground truth** (corrupted models): defect records and
   derived expectations written by the corruption layer at plant time.
3. **Checks that run the pipeline on the serialized bytes** - schema
   verdict, clash detection, and an independent quantity re-extraction.
   Since v2 these run in-process (`lib/checks.mjs`) via the exact functions
   `ifc-lite validate` / `ifc-lite clash` call (`computeValidationIssues`,
   `GeometryProcessor` + `elementsFromStep` + `createClashEngine`), with one
   warm WASM processor per worker. The v1 subprocess path is retained
   behind `--engine subprocess` for A/B measurement.

## Reward channels (the single env API)

`lib/reward-channels.mjs#computeRewardChannels(manifestLine, opts)` - one
manifest line in, five scalars in [0, 1] out:

| Channel | Definition | 100k distribution (clean / corrupted mean) |
|---|---|---|
| `schemaValidity` | 1 valid no warnings, 0.5 valid with warnings, 0 invalid | 1.0 / ~0.33 |
| `clashScore` | `1 / (1 + detected clashes)` | 1.0 / ~0.82 |
| `determinismHashMatch` | candidate sha256 == manifest sha256 (no candidate = regenerate from seed) | 1.0 self-eval; 0 on every tampered candidate |
| `quantityAccuracy` | 1 - mean relative error, re-extracted totals vs ground truth | 1.0 / <1 when quantities were removed |
| `defectDetection` | planted defect types detected / planted (clean: 1 unless phantom detection) | 1.0 / <1 (dangling-ref is invisible - real gap, surfaced not hidden) |

`channel-report.mjs` proves discrimination over a corpus: per-channel value
histograms split clean/corrupted, a regenerate-and-rehash determinism
re-proof over a deterministic 10% slice, and a tamper probe (one flipped
byte must drop `determinismHashMatch` to 0). On the 100k corpus every
channel is non-constant across classes and the tamper probe was 100/100.

Relationship to `ifc-lite gym` (B0.4 -> B2.2): `packages/cli/src/commands/
gym.ts` is a reset/step/reward loop with schema/clash/ids channels, and
since B2.2 it doubles as the benchmark's **episode factory**: `--seed <n>`
(or a mid-session `{"type":"reset","seed":n}` command) generates a World Gym
model in-process and serves it over the same JSONL protocol, with an
`episode: {seed, family, corrupted}` descriptor on generated-episode resets.
Corruption defaults to the benchmark's deterministic Bernoulli(0.3) draw;
`--corrupt` / `--no-corrupt` / `--corrupt-rate p` override. The factory
needs the repo checkout (the npm package does not ship tools/world-gym; it
fails with a clear error there and `--model` keeps working). The five
corpus-level channels above and the gym's interactive channels remain
different layers; `computeRewardChannels` stays the corpus/manifest API.

## Determinism

Two non-obvious entropy leaks live inside `@ifc-lite/create` /
`@ifc-lite/encoding`, both **outside tools/world-gym's own path** so they are
documented and worked around here, not patched at the source:

- `packages/create/src/ifc-creator.ts` calls `Date.now()` (owner-history
  timestamp) and `new Date().toISOString()` (STEP header `FILE_NAME`
  timestamp) directly, with no seed hook.
- `packages/encoding/src/guid.ts#generateUuid()` calls `crypto.randomUUID()`
  for every `IfcGloballyUniqueId` - the dominant determinism blocker.

`lib/deterministic-runtime.mjs` works around both without touching either
package: for the duration of one synchronous `build()` + `toIfc()` call, it
replaces `globalThis.Date` with a subclass pinned to a fixed epoch and
replaces `globalThis.crypto.randomUUID` (plus `Math.random`, defensively)
with a seeded generator, then restores both in a `finally`.

**Result: `node determinism-check.mjs --seeds 20` - 20/20 seeds
byte-identical across two runs, wall-clock gap included; corrupted models
verified byte-identical the same way; the 100k channel report re-proved
10,000 models by regenerate-and-rehash with 0 failures.**

If GlobalId/timestamp seeding is ever added upstream, this shim becomes
unnecessary and should be deleted - it is a workaround, not a design choice.

## 100k corpus run - results (this machine, 10 cores, 10 workers)

```text
requested / completed / failed:   100000 / 100000 / 0
wall time:                        126.4 s  (2m 6s)
throughput:                       791.0 models/sec  (v1 subprocess engine: 6.6/sec -> ~120x)
label coverage:                   100000/100000 (100%): entity counts, quantities,
                                   schema verdict, clash verdict, quantity re-extraction
label classes:                     69693 clean / 30307 corrupted (corruptRate 0.3)
defect instances:                  8531-8728 per defect type (7 types, near-uniform)
schema verdicts:                   79554 valid / 20446 invalid
clash totals:                      91272 zero / 8728 with 1-3 detected pairs
ground-truth agreement:            100000/100000 models, every dimension
                                   (schema, clash, degenerate, quantity) - allMatchRate 1.0
determinism re-proof:              10000/10000 regenerated models re-hash to the
                                   manifest sha256; 100/100 tampered candidates score 0
dedup:                             100000 unique content hashes, 0 duplicates
entity counts:                     min 244, median 641, p95 3549, max 4840
per-model timing:                  generation median 1 ms; total (gen+label) median 7 ms, p95 33 ms
```

Reward-channel distributions over this corpus (clean mean / corrupted mean):
`schemaValidity` 1.0 / 0.325, `clashScore` 1.0 / 0.817, `quantityAccuracy`
1.0 / 0.935 (293 distinct values, min 0.52), `defectDetection` 1.0 / 0.855
(the shortfall is exactly the invisible `dangling-ref`),
`determinismHashMatch` 1 on every self-evaluation and 0 on every tampered
candidate. No channel is constant across classes.

Corpus artifacts (manifest.jsonl ~190 MB, summary.json, channels-report.json,
oracle-report.json) are run outputs written outside the repo; they are not
checked in. `.ifc` bytes are not kept at this scale (`--no-keep-files`) -
every model is reproducible from its seed, and `oracle-validate.mjs`
verifies regenerated sha256 against the manifest before using regenerated
bytes.

### Throughput: what changed vs v1

v1 paid two fresh `node dist/index.js` subprocess launches per model
(validate + clash), ~1.4 s median per model, 6.6 models/sec on 10 workers.
v2 imports the same building blocks in-process and keeps one WASM geometry
processor warm per worker: median label cost fell to ~6 ms, throughput rose
to 791 models/sec end to end (measured A/B on 200 models: 6.58/s subprocess
vs 186/s in-process, the latter pool-start dominated; at 100k scale
amortization pushes it to 791/s). A 100k corpus now costs ~2 minutes on one
laptop; 1M extrapolates to ~21 minutes.

## IfcOpenShell differential oracle

`oracle-validate.mjs` + `oracle_validate.py` spot-validate labels against
IfcOpenShell 0.8.5 (the exact pin from
`tools/ifcopenshell_reference/requirements.lock`; the harness's own local
venv recipe applies). Per sampled model, the oracle independently:

- parses the file and confirms the schema;
- recounts entities per type (expectations adjusted for planted text
  defects);
- recounts duplicate GlobalIds (must equal planted count, 0 for clean);
- re-sums the embedded GymQuantities and compares to the labeler's
  extraction at 1e-6 relative tolerance;
- meshes every product with its own geometry kernel and compares slab /
  column / beam volumes to ground truth at 1%, and wall volumes net of the
  planted openings;
- verifies the planted footing pairs overlap by the recorded penetration in
  ITS geometry (AABB overlap, 1 mm tolerance);
- verifies the planted zero-height columns are degenerate for it too.

Result on the 100k corpus (200-model deterministic sample, `seed % 500 ==
0`, 144 clean / 56 corrupted): **200/200 models pass all seven checks**
(parse, entity-counts, guid-dups, quantities, geometry-volume, clash-pairs,
degenerate), with 0/200 regeneration sha mismatches. The validation layers each caught a real
corpus bug during bring-up: the 100k agreement stats caught
`String.replace` garbling planted duplicate GUIDs containing `$` (a
replacement-pattern metacharacter, 120 affected models), and the oracle
caught the duplicated IfcProject silently doubling as an unplanned GUID dup
- both fixed in `lib/corruption.mjs`. The redundancy is doing its job.

## Deviation from the brief / known gaps

- **The discipline clash matrix is structurally blind to this corpus.**
  `disciplineMatrixRules()` only pairs MEP/HVAC/ELEC/FIRE selectors against
  structure/architecture; a corpus containing only walls, slabs, columns,
  beams and spaces can never fire a single matrix rule. The v1 pilot's
  "0 clashes across 1,000 models" was therefore vacuous - not evidence of
  clean geometry. v2 keeps the matrix (parity) and adds an `IfcFooting`
  self-clash rule that the injected clash pairs (a type no clean family
  emits) trigger exactly. A follow-up should add ARCH/STR self-clash rules
  plus baseline-noise budgets so the channel can grade *organic* clashes
  too, not only planted ones.
- **`dangling-ref` is undetected by `ifc-lite validate`.** The planted
  ground truth records it anyway, and the `defectDetection` channel scores
  the miss (models carrying it score < 1) - surfacing the gap instead of
  hiding it. Upstream candidate: a reference-integrity rule in
  `computeValidationIssues`.
- **`ifc-lite validate` exits non-zero on invalid files**, so the v1
  subprocess labeler could not even record a negative schema verdict
  (`schemaCheck.ok = false` instead of `valid: false`) - visible in the A/B
  run. The in-process engine reads the verdict directly; the subprocess
  path keeps the flaw for honesty.
- **`ifc-lite clash --json` leaks non-JSON diagnostics to stdout** (from
  the geometry pipeline's console bindings, some captured at WASM init and
  immune to scoped console patching - in-process the labeler patches
  console to stderr process-wide at init). Still worth fixing upstream in
  `packages/cli` / `packages/geometry`.
- **GlobalId/timestamp non-determinism in `@ifc-lite/create` /
  `@ifc-lite/encoding`** - see "Determinism". Worked around via a runtime
  shim, not fixed at the source.
- **`ifc-lite gym` integration is DONE** (B2.2): the generator is wired into
  the gym as an episode factory (`--seed` / reset-with-seed, see Reward
  channels above), with tests in `packages/cli/src/commands/gym.test.ts`.
  Still open on that surface: `HeadlessBackend.mutate` remains a no-op stub
  (the gym drives `MutablePropertyView` directly), no entity-creation ops,
  `done` never fires, `observation.bounds` always null.
- **The defect-detection task is near-saturated by text heuristics
  (measured, v1.0).** On the dev split the no-kernel `heuristic-text`
  baseline scores macro-F1 1.0 while the kernel oracle scores 0.857 (it
  cannot see `dangling-ref`). The v1 corruption layer plants mostly
  text-level defects, so v1.0's defect task rewards pattern-matching the
  corruption conventions; real headroom currently lives in
  quantity-estimation (both anchors 0.978 - the missing-quantities share
  requires geometry to recover) and in generalization. Spec v1.1 should add
  geometric/organic defect families (misalignment, unit-scale errors,
  off-by-storey placement) that text scans cannot see. Documented in
  BENCHMARK.md section 5.
- **Test-split integrity is honesty-based until hosting exists.** Labels
  are regenerable-by-seed by design (open generator), so local test rows
  are self-reported; the trusted channel is a hosted leaderboard that
  scores test submissions server-side. Public hosting, benchmark
  governance/licensing, and external-lab recruitment are HUMAN-track items
  (execution plan B2.2), not covered by this code.
- **Leaderboard verifier is Node-side, not yet client-side in a browser.**
  The M2 final exam wants the leaderboard verifier running client-side;
  score.mjs + the generator are plain ESM with no Node-only APIs beyond
  fs/crypto entrypoints, so a browser build is packaging work, but it is
  not done.
- Coverage is intentionally narrower than everything `packages/create`
  supports (stairs, roofs, doors, windows, ramps, railings, plates,
  members, piles, curtain walls, ...). The family module interface
  (`{ name, paramSpace(rng), build(creator, params) }`) is designed so a
  third family drops in without touching `generator.mjs`, `labeler.mjs`, or
  `run-pilot.mjs`.
- Room footprints in `office` use grid centerlines (documented v1
  approximation, unchanged).

## Constraints honored

- Own path: everything lives under `tools/world-gym/**`; nothing outside
  that path was modified (gaps above are documented, not patched, for
  exactly that reason).
- No new npm dependencies - plain `.mjs` with Node built-ins plus relative
  imports into already-built `packages/*/dist`. The oracle needs a python
  venv with `ifcopenshell==0.8.5` (same pin as
  `tools/ifcopenshell_reference`), created outside the repo.
- Generated corpora (IFC files, manifests, reports) are written outside the
  repo and are not checked in.
