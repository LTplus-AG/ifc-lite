# World Gym — procedural building generator + deterministic labeler

M2 midterm exam (Phase 1, Bet B1.2 in `docs/vision/moonshots-execution-plan.md`):
the "data factory" play from `docs/vision/moonshots-tech.md` M2 — a procedural
generator + deterministic labeling pipeline over `packages/create`, piloted at
1,000 models with a documented scaling path to 100k.

Every sample gets perfect ground-truth labels because the labels are either
the exact numbers used to author the geometry (not re-derived from the file),
or come from actually running the kernel's own check commands on the
serialized bytes.

## Quick start

```bash
# One model, standalone
node generator.mjs --seed 42 --family frame --out /tmp/model.ifc --json

# One model, generated + labeled (writes the file, prints one JSONL line)
node labeler.mjs --seed 42 --family frame --model-dir /tmp/world-gym

# Determinism proof over 20 seeds (see "Determinism" below)
node determinism-check.mjs --seeds 20

# The 1,000-model pilot (output MUST go outside the repo)
node run-pilot.mjs --count 1000 --out-dir /path/outside/repo/world-gym-pilot --workers 10
```

`--family` accepts `frame`, `office`, or `auto` (default — the seed itself
picks the family, so `--seed N` alone still determines one specific building
end to end).

## Architecture

```
tools/world-gym/
  lib/
    rng.mjs                   deterministic seeded PRNG (mulberry32 + FNV-1a seed hash)
    deterministic-runtime.mjs shim that pins Date/crypto.randomUUID for one build (see Gaps)
    quantities.mjs            wall/slab/column/beam/space quantity math, shared by both families
  families/
    frame.mjs                 Family A: multi-storey slab-and-column frame
    office.mjs                Family B: single-storey partitioned office slab
  generator.mjs                generateModel(seed, family) -> {content, entities, labels, ...}; CLI wrapper
  labeler.mjs                   labelModel(model, filePath) -> manifest line; CLI wrapper
  worker.mjs                    per-model worker: generate + write + label, over IPC
  run-pilot.mjs                 worker-pool orchestrator: N models, dedup, timing, summary.json
  determinism-check.mjs         byte-identical proof over N seeds
```

`generateModel()` is the single source of truth. It:

1. Derives a family choice (`{seed}:family` sub-stream) and a parameter draw
   (`{seed}:params:{family}` sub-stream) from independent RNG streams keyed
   off the seed — so adding a third family later cannot perturb any existing
   seed's building.
2. Builds the model into one `IfcCreator` instance using the exact same
   `@ifc-lite/create` methods the CLI's `ifc-lite create` command calls
   (`addIfcWall`, `addIfcSlab`, `addIfcColumn`, `addIfcBeam`, `addIfcSpace`,
   `addIfcElementQuantity`, wall `Openings`) — metres, identity placement,
   one `toIfc()` call, per house convention.
3. Wraps the whole build + `toIfc()` in `withDeterministicRuntime(seed, fn)`.

`labelModel()` then produces one manifest line per model, combining two
categorically different kinds of label (see "Label sources" below).

## Family parameter spaces

### Family A — `frame` (rectangular multi-storey slab-and-column frame)

Perimeter walls with generic rectangular openings cut (never filled by a
door/window — "door/window-free openings" per the brief) ring every storey; a
column grid sits at every bay intersection; beams tie the grid together at
the top of each storey; a slab floors every level plus one roof slab on top.

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

Elements per model: `IfcWall` (4 x storeys, some with `IfcOpeningElement`
voids), `IfcSlab` (storeys + 1 roof), `IfcColumn` ((baysX+1)x(baysY+1) x
storeys), `IfcBeam` (two directions x storeys). Pilot range: 553-4,749
entities (median 1,913).

### Family B — `office` (single-storey partitioned office slab)

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

Elements per model: `IfcSlab` (1), `IfcWall` (4 perimeter + (rows-1)+(cols-1)
partitions), `IfcSpace` (rows x cols). Pilot range: 248-641 entities (median
380). Room footprints use the grid centerline, not partition-half-thickness
subtraction — a documented v1 approximation, good enough for reward-channel
ground truth.

Both families are deliberately non-adversarial in v1: no family intentionally
produces an invalid or clashing model (see "Known gaps" — the 1,000-model
pilot came back 100% schema-valid and 0 clashes, which is a real limitation
for training a *discriminative* reward signal, not just a positive-only one).

## Label sources ("perfect ground truth", two kinds)

1. **Generation-parameter ground truth (free, exact, cannot drift).**
   `entityCountsByType` comes straight from `IfcCreator`'s own
   `result.entities` array — the creator's own bookkeeping of what it built,
   not a re-parse. `storeyCount` and every quantity (`wallGrossVolume`,
   `slabGrossArea`, `roomNetFloorArea`, footprint area, gross floor area, ...)
   come straight from the family module's `build()` return value: the exact
   same numbers used to author the geometry *and* the `IfcElementQuantity`
   sets embedded in the file via `addIfcElementQuantity` (`lib/quantities.mjs`
   computes each element's numbers once, feeds both the STEP output and the
   label).
2. **Checks that require actually running the pipeline on the serialized
   bytes** — schema/structural validity and clash count. These reuse the
   CLI's own `ifc-lite validate --json` and `ifc-lite clash --matrix --json`
   commands via subprocess rather than reimplementing that logic (see
   "Deviation from the brief" below — the plan referenced an `ifc-lite gym`
   reset line that does not exist in this worktree).

## Reward-channel mapping (for M2's gym / B2.2's benchmark)

Every label in the manifest line is a candidate reward channel for the RLVR
loop the moonshot describes:

| Manifest field | Reward channel |
|---|---|
| `schemaCheck.valid`, `.errors`, `.warnings` | parses / is schema-legal |
| `clash.total`, `.bySeverity` | clash-free (currently always 0 — see gaps) |
| `groundTruth.totals.*GrossVolume` / `*GrossArea` | quantities-within-budget (compare an agent's output Qtos to ground truth) |
| `entityCountsByType` | structural completeness (did the agent emit every expected element type) |
| `storeyCount`, `groundTruth.footprint` | spatial-structure correctness |
| `sha256` | exact-match / dedup channel (agent reproduced the byte-identical target) |

The gap is that v1's corpus is 100% positive-label (every model is valid,
zero clashes) — a real reward signal needs negative examples too (schema
violations, intentional clashes, missing quantities). That is direct backlog
for whichever bet extends this generator (B2.2 benchmark launch, most
likely): add a `--corrupt` mode or a third "adversarial" family that
deliberately overlaps elements / omits required entities / breaks a specific
IDS rule, at a documented rate, so the reward channels have both classes to
discriminate.

## Determinism

Two non-obvious entropy leaks live inside `@ifc-lite/create` /
`@ifc-lite/encoding`, both **outside tools/world-gym's own path** so they are
documented and worked around here, not patched at the source:

- `packages/create/src/ifc-creator.ts` calls `Date.now()` (owner-history
  timestamp) and `new Date().toISOString()` (STEP header `FILE_NAME`
  timestamp) directly, with no seed hook.
- `packages/encoding/src/guid.ts#generateUuid()` calls `crypto.randomUUID()`
  for every `IfcGloballyUniqueId` — the actual, dominant determinism blocker.
  A first pass (diffing two un-shimmed generations of the identical model)
  showed the *only* differing lines were GlobalIds; the header/owner-history
  timestamps happened not to visibly differ in that quick test only because
  both calls landed in the same wall-clock second — they are just as real a
  leak and would fail on any run that crosses a second boundary.

`lib/deterministic-runtime.mjs` works around both without touching either
package: for the duration of one synchronous `build()` + `toIfc()` call, it
replaces `globalThis.Date` with a subclass pinned to a fixed epoch and
replaces `globalThis.crypto.randomUUID` (plus `Math.random`, defensively, for
`generateUuid()`'s no-crypto fallback branch) with a seeded generator, then
restores both in a `finally`. `determinism-check.mjs` proves this holds by
generating each of the first 20 seeds twice with a real wall-clock delay
(default 60ms, spanning a real timer tick) between the two runs and hashing
both outputs.

**Result: `node determinism-check.mjs --seeds 20` — 20/20 seeds
byte-identical across two runs, wall-clock gap included.** (Verified in this
session; re-run to reproduce.)

If GlobalId/timestamp seeding is ever added upstream to `@ifc-lite/create` or
`@ifc-lite/encoding`, this shim becomes unnecessary and should be deleted —
it is a workaround, not a design choice.

## 1,000-model pilot — results

Run on this machine (10 logical cores), `--workers 10`, family `auto` (seed
picks family), seeds 0-999, checks not skipped (both `validate` and `clash`
ran for every model):

```
requested / completed / failed:   1000 / 1000 / 0
wall time:                        150.365 s  (2m 30s)
throughput:                       6.651 models/sec
dedup:                            0 duplicate content hashes out of 1000 (dedupRate 0)
label coverage:                   1000/1000 (100%) — every model got entity counts,
                                   quantities, schema verdict, AND clash count
family distribution:               office 485 / frame 515
entity-count distribution:         min 248, median 641, p95 3541, max 4749
  - frame only:                    min 553, median 1913, max 4749
  - office only:                   min 248, median 380, max 641
schema-check verdict:              1000/1000 valid=true, 0 errors, 0 warnings (sum across corpus)
clash verdict:                     1000/1000 total=0 (no model clashed — see reward-channel gap above)
extrapolated cost of 100k:         ~4.18 hours on this machine at this rate (linear extrapolation)
```

Full manifest and summary are pilot artifacts written to whatever `--out-dir`
was passed (this session used the session scratch directory, *not* the
repo — see "Constraints" below); they are not checked in.

### Per-model timing breakdown

```
generation only (in-process, no subprocess): min 0ms, median 1ms, p95 8ms, max 34ms
total per model (gen + write + validate subprocess + clash subprocess, run concurrently): 
  min 764ms, median 1434ms, p95 2026ms, max 2774ms
```

Generation itself is essentially free (sub-10ms median). The entire
per-model cost is two Node subprocess launches (`ifc-lite validate`,
`ifc-lite clash --matrix`), each paying ~250-500ms of Node startup + module
load + (for clash) WASM geometry-processor init, run concurrently via
`Promise.all` inside `labelModel()` but still gating the model on the slower
of the two. This is the single biggest lever for scaling further (see next
section).

## Scaling path to 100k (and beyond)

At the pilot's measured throughput (6.65 models/sec, 10 workers on 10 cores,
checks not skipped), 100k models extrapolates linearly to **~4.2 hours** on
this exact machine. That number is a *lower bound on effort, not a plan* —
the real path to 100k (and to the 1M-scale corpus M2's "data factory" play
describes) is to remove the per-model subprocess tax entirely, in priority
order:

1. **Amortize the CLI subprocess cost across models, per worker.** Right now
   every model pays two fresh `node dist/index.js <cmd>` process launches.
   Importing `@ifc-lite/parser` + `@ifc-lite/geometry` + `@ifc-lite/clash`
   directly inside each long-lived worker (the same modules `validate.ts`
   and `clash.ts` import) and keeping one `GeometryProcessor` instance warm
   per worker would turn "two Node startups + one WASM init per model" into
   "one WASM init per worker, amortized across its whole shard." This is the
   single highest-value change and was scoped out of v1 to keep `labeler.mjs`
   a thin, obviously-correct reuse of the existing CLI surface rather than a
   re-plumbing of the geometry pipeline — worth doing before a 100k run.
2. **More cores / more machines.** The worker pool is already sized to
   `os.cpus().length` and the whole pipeline is embarrassingly parallel
   (every model is independent) — this is a pure horizontal-scaling problem
   once (1) removes the subprocess tax. Split `--seed-start`/`--count`
   ranges across machines and concatenate `manifest.jsonl` files; nothing in
   the design assumes a single host.
3. **Skip clash for the bulk, sample it.** Given v1's frame/office families
   never clash by construction (0/1000 in this pilot), running full clash
   detection on every one of 100k models is mostly spending compute to
   confirm a foregone conclusion. Once an adversarial/corrupted family exists
   (see reward-channel gap above), clash becomes informative and should run
   on 100% of *that* family; for the non-adversarial families, a 5-10%
   sample for QA is defensible and cuts the dominant cost roughly in half.
4. **Batch schema validation.** `ifc-lite validate` re-parses the whole file
   from disk per call; a long-lived worker holding the parsed `IfcDataStore`
   already in memory (from generation) could run the same required-entity /
   GlobalId-uniqueness checks in-process for near-zero marginal cost per
   model — same "reuse the check logic, not the subprocess" idea as (1).
5. **What B2.2 (benchmark launch) will need on top of this:** held-out
   splits (this pilot's `sha256` field plus `{seed, family}` is enough to
   define a deterministic train/held-out split — e.g. `seed % 10 == 0` held
   out — without re-generating anything); the client-side verifier the
   benchmark promises is exactly `labelModel()`'s "checks that require
   running the pipeline" half, already factored out as a reusable function;
   and the negative-label / adversarial family from the reward-channel gap
   above, since a benchmark that only ever contains valid models cannot
   distinguish a lucky agent from a correct one.

## Deviation from the brief / known gaps

- **`ifc-lite gym` does not exist in this worktree.** The task brief said
  "reuse the `ifc-lite gym` reset line or the check commands" — this
  worktree's `packages/cli/src/commands/` has no `gym.ts`, no `gym` string
  anywhere in the CLI source, and no README section describing it. Reused
  `ifc-lite validate --json` and `ifc-lite clash --matrix --json` instead,
  exactly per the brief's fallback clause.
- **`ifc-lite clash --json` leaks non-JSON diagnostic lines to stdout.**
  `[IFC-LITE] Opening classifier: ...`, `rect_fast: fired ...` and similar
  lines are written to stdout by the geometry/opening-cutting pipeline
  itself (deep under `GeometryProcessor`, not through `clash.ts`'s own
  `printJson`), unconditionally — not gated by `--json` or any `--quiet`
  flag. This breaks naive `JSON.parse(stdout)` for any programmatic
  consumer, not just this pilot. Worked around in `labeler.mjs`
  (`extractTrailingJson()`, finds the first stdout line that is exactly `{`
  and parses from there) rather than fixed upstream, since that is outside
  `tools/world-gym`'s own path. Should be fixed in `packages/cli` (route
  those diagnostics through the same logger `loader.ts` already uses to
  suppress parser console output) or `packages/geometry`.
- **GlobalId/timestamp non-determinism in `@ifc-lite/create` /
  `@ifc-lite/encoding`** — see "Determinism" above. Worked around via a
  runtime shim, not fixed at the source.
- **v1 corpus has no negative labels** — every generated model is valid and
  clash-free by construction; see the reward-channel section above.
- Coverage is intentionally narrower than "every element family
  `packages/create` supports" (it also has stairs, roofs, doors, windows,
  ramps, railings, plates, members, footings, piles, curtain walls,
  furnishings, and a dozen structural-profile variants). Two families were
  enough to satisfy the brief's "at least TWO families" bar and to exercise
  five distinct element types (`IfcWall`, `IfcSlab`, `IfcColumn`, `IfcBeam`,
  `IfcSpace`, plus `IfcOpeningElement`) end-to-end with quantities; breadth
  into stairs/roofs/openings-with-fills is a ratchet for whoever picks this
  up next, not a blocker — the family module interface
  (`{ name, paramSpace(rng), build(creator, params) }`) is designed so a
  third family drops in without touching `generator.mjs`, `labeler.mjs`, or
  `run-pilot.mjs`.

## Constraints honored

- Own path: everything pilot-relevant lives under `tools/world-gym/**`;
  nothing outside that path was modified (the gaps above are documented, not
  patched, for exactly that reason).
- No new npm dependencies — plain `.mjs` with only Node built-ins
  (`node:crypto`, `node:child_process`, `node:fs/promises`, `node:os`,
  `node:path`) plus relative imports into already-built
  `packages/create/dist` and a subprocess call into already-built
  `packages/cli/dist`.
- Generated corpus (IFC files, manifest, summary) was written to the session
  scratch directory, never into the repo, and nothing here was committed.
