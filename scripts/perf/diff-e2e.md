<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Diff end-to-end cohort protocol (#8042)

**Unmeasured, proposed for parent review.** The tool always reports
`performanceVerdict: not-assessed` and `fullIssue8042Accepted: false`. No
production code or performance ledger is changed. The parent owns heavy
preparation, exclusive admission, approval, interpretation, and future acceptance.

Use Node 22.13+ in 22.x or Node 24.x. Imports are built JavaScript, without an
implicit TS loader or builds. The primary workload calls the **final public
`diffModels` facade** on both arms. The Rust arm requires public `initDiff()`
and uses its actual Node asset resolution. Preparation source `98800519` still
exports the TS facade and deliberately fails Rust-arm preparation: integrate
the final production facade first. There is no internal-adapter fallback.
Choose a TS baseline before facade cutover. The branch CLI must also use the
Rust fingerprint pipeline before full #8042 acceptance; this harness includes
its public builder cost but does not independently certify that implementation.

## Workloads and proof separation

For each fixture, run separate proof children first, then cold and warm timing
children. Proof children audit actual ESM resolution and transitive CommonJS
`require` resolution, validate original object identity and hash full inputs and
results. They exercise every option and repeated call. Hashes preserve Map and
array order, absent versus undefined optional fields, nonfinite/-0 values and
lone UTF-16 surrogates. Each pair must have identical fingerprints and results,
including original JS references and secondary claims. This is implementation
parity, not external authoring-tool ground truth.

Each timing arm/round/option/workload is a **fresh process**, sequential on the
same host with seeded balanced interleaving. There are no proof hashes, result
traversals, loader audit writes or forced GC between timed calls. The proof
processes exit before measurement; their JIT, heap and GC state cannot survive.
OS filesystem caches remain uncontrolled and may be warm from preparation/proof.
This is cold JS/WASM state, not cold disk latency. Fixed option order is 0,1,2;
cold workloads precede warm workloads. Each option gets its own processes.

- **Cold:** one option and one public call. `lifecycleTotalMs` continuously spans
  module imports, initialization, reads, parse, fingerprints, derived construction
  when applicable, public diff, reference restoration, per-call handle freeing,
  JS-row release and explicit GC. Nothing is subtracted or stitched on later.
- **Warm:** a separate process builds inputs and makes one conditioning call,
  then retains JS fingerprints for the configured repeats of one option. Every
  repeat calls the production facade, including packing, constructing handles,
  comparison, restoring references and freeing handles **per call**. The primary
  warm endpoint is the median public-call `totalMs` within that process.
  `lifecycleTotalMs` additionally describes the whole continuous warm lifecycle,
  including conditioning and final release. It is not cold latency.
- No handle-reuse workload is currently offered. A future handle-reuse experiment
  must be separately named and cannot replace primary production-call results.

Public-call costs are inclusive: no private adapter instrumentation pretends to
separate marshaling from restoration. Import/init/read/parse/fingerprint/release
phases remain available. `processWallMs` additionally includes Node startup,
protocol imports, IPC and exit. Memory snapshots, release GC and max RSS are
reported descriptively; releasing handles need not shrink WASM linear memory.
All these CLI timings are **data-only**: enabling the third option does not
create geometry fingerprints or prove split/merge or successor coverage.

Retained repeats are correlated. Reports preserve raw repetitions, then compute
**one median per process** and paired process-level deltas and ratios. The
independent unit is a fresh process pair, never a flattened repetition. Cold
lifecycle distributions likewise have one observation per arm/process pair.

## Freeze and approve before measurement

Generate a draft without builds, fixtures or timing:

```bash
node scripts/perf/diff-e2e.mjs plan --out /absolute/evidence/draft.json \
  --pairs 5 --seed 8042 --stress-rows 750000 --retained 3 \
  --large-base /absolute/large-base.ifc --large-head /absolute/large-head.ifc
```

An unbound draft cannot run. The final reviewed protocol adds `--bindings
/absolute/evidence/bindings.json`. Bindings are programmatically assembled by
parent preparation from actual receipts, using `digest`, `fileReceipt`,
`harnessReceipt`, `sourceReceipt` and `runtimeReceipt` from the harness modules:

```js
{
  runtime: await runtimeReceipt(), // Node version, path and executable SHA256
  harnessSource: sourceReceipt('/absolute/harness'), // exact clean harness commit/tree
  measurement: { hostname: 'ACTUAL_HOST', idleProbes: {
    scope: 'linux-and-physical-host', commands: ['ACTUAL scheduler/host probe commands'],
    intervalMs: 1000, requiredIdle: 'no unrelated runnable work'
  } },
  harness: digest(await harnessReceipt()), // exact harness/module bytes and paths
  base: digest(baseInventory), branch: digest(branchInventory), // source commit/tree + all bytes
  fixtures: { demo: [baseFileReceipt, headFileReceipt], /* haus, large, stress */ }
}
```

The idle probe interval must be 1–60 seconds; the parent must choose probes
that establish the required physical-host ownership and idle window. The harness
validates the frozen plan, while the parent validates actual probe evidence.
Fixture receipts contain real absolute path, size and SHA256. The harness
source must be clean and match its frozen commit/tree as well as its byte digest. The runner
reconciles bindings before sampling, fixture receipts before/after each case,
and inventories, runtime and harness bytes after the cohort. Moving prepared
roots or changing bytes requires new preparation and review.

Protocol v2 contains proposed numeric criteria for parent approval **before any
cohort is inspected**:

- Primary endpoints: cold lifecycle and warm per-process median public-call
  latency, all three options on demo, Haus, real large IFC revision pair
  (authored or controlled derived as specified below) and stress.
- Noninferiority margin: branch/base 1.05. A speedup claim additionally requires
  branch/base below 0.95 on every large/stress primary endpoint.
- One-sided exact paired sign tests against the margin, ties against the claim;
  Holm correction across all primary case/option/endpoints, familywise alpha
  0.05. Neutrality requires every primary endpoint to establish noninferiority.
  Otherwise parent distinguishes supported regression from inconclusive evidence.
- Resolution: cold endpoints at least 1 ms, warm endpoints at least 0.1 ms, both
  at least 100 observed clock ticks. Each child reports its minimum positive
  `performance.now()` step from 1,000 premeasurement clock probes.
- Noise: per-arm `(max-min)/median` across process summaries at most 20%.
- Any failed idle/exclusive probe, timeout, failure, changed identity or
  resolution/noise violation makes the cohort inconclusive. Preserve every
  observation; no replacement, exclusion, automatic retry or post-hoc relaxation.

At least five pairs are mandatory, **not guaranteed decisive**. Five pairs
cannot establish Holm-corrected significance over all 24 primary endpoints:
even five successes give a minimum one-sided exact sign-test p-value of
1/32, above the first Holm threshold of 0.05/24.
Choose sample size (up to 25 pairs) and a fixed analysis before measurement;
if inconclusive, retain the entire cohort and seek review of a new protocol.
These criteria are a proposal, not an approval or automated verdict. The parent
must explicitly approve the exact protocol hash and interpretation plan.

## Parent preparation and receipts

Keep separate clean Linux TS-base and Rust-branch checkouts, exact commits,
pinned toolchains and root pnpm/Turbo dependency builds. Ordinary validation
continues through `~/build-workers/ifc-fleet`. For this proposed custom protocol,
source-pinned, artifact-producing preparation must stay on the measurement host.
It may use that host's registered `~/build-workers/run-heavy` directly with
explicit `--kind ordinary`, followed by the complete custom cohort with explicit
`--kind benchmark`. Invoke each launcher outside any existing reservation;
never nest admission or invoke fleet/qualification inside an admitted command.

Policy references: `~/build-workers/fleet-policy.md` line 9 preserves host-local
commands and exclusive physical-host timing; line 30 retains the original explicit
workflow for custom/WASM benchmarks. `~/build-workers/AGENTS.md` lines 5–6 require
one shared storage task and publication of launch-time declared artifacts.
The current fleet facade does not forward `--artifact` in local or remote calls;
the registered host-local launcher accepts repeated `--artifact` and records
their digests in the original scheduler execution receipt's `artifacts`.
This narrow preparation route supplies the provenance required by
`validateBuildReceipt`; it changes no deployed worker, receipt format or verifier.

Preparation invocation template (repeat for base and branch, sharing the same
task ID; CPU count, memory in GiB and timeout in seconds are explicit bounds):

```bash
~/build-workers/run-heavy --cwd /absolute/branch --kind ordinary \
  --storage-task UNIQUE_COHORT_TASK --cpu 4 --memory 16 --timeout 7200 \
  --artifact /absolute/task-output/branch.build-manifest.json \
  --artifact /absolute/task-output/branch.inventory.json \
  -- bash /absolute/preparation/prepare-branch.sh
```

The preparation script is a template path, not an existing or successful build:
freeze its actual path, source identity and exact install/build/audit/inventory/
manifest commands before execution. It must produce the declared files before
the admitted command completes. Freeze actual prepared paths, artifact paths,
original receipts and wrappers in the reviewed protocol before measurement.
The protocol remains proposed and unfrozen pending parent review after fleet
facade qualification; these templates assert no preparation or acceptance result.

Remove relevant generated outputs and disable Turbo/build caches for fresh
source builds, including independent diff WASM via the repository workflow.
Never copy an old binary to new source or treat unchanged bytes as freshness.
Do not alter another task's locks, outputs or active jobs.

Inside that preparation, discover actual runtime imports in **untimed proof
processes** (this can parse real models; it is parent-owned admitted work):

```bash
node /absolute/harness/scripts/perf/diff-e2e.mjs audit \
  --protocol /absolute/evidence/draft.json --root /absolute/branch \
  --implementation rust-wasm --fixture-root /absolute/fixtures \
  --out /absolute/task-output/branch-audit
node /absolute/harness/scripts/perf/diff-e2e.mjs inventory \
  --root /absolute/branch --implementation rust-wasm \
  --runtime-paths /absolute/task-output/branch-audit/runtime-paths.json \
  --out /absolute/task-output/branch.inventory.json
```

Repeat for base using `--implementation typescript`. Inventories cover required
entry points, all workspace dist JS/JSON/WASM, WASM payloads, lockfile/package
metadata, actual resolved runtime files (including external dependencies) and
their package metadata. Frozen-lockfile installation is required. Audited paths
from the later cohort must resolve to those exact prepared bytes; unprepared
paths fail. The audit hooks only run in proof children. Resolution logs are
bounded to 32 MiB; dependency inventories to 30,000 files. This covers Node's
ESM and CommonJS resolvers, not arbitrary application file reads. WASM binaries
and fixture reads are separately inventoried; introducing another non-module
runtime asset requires explicit inventory coverage before acceptance.

The admitted rebuild must emit a JSON output manifest as a declared worker
artifact, **before its successful worker completes**. Manifest schema:

```js
{
  version: 'ifc-diff-build/1', status: 'succeeded', exitCode: 0,
  freshOutputs: true, // trusted preparer attests clean outputs/cache-free rebuild
  root: inventory.root, implementation: inventory.implementation,
  source: inventory.source, runtime: inventory.runtime,
  commands: ['EXACT successful install/build/audit/inventory commands'],
  workerCommand: ['EXACT', 'worker', 'command', 'argv'],
  toolchain: 'ACTUAL pinned Rust/pnpm/wasm-pack versions and receipt references',
  startedAt: 'ACTUAL ISO time', finishedAt: 'ACTUAL ISO time',
  outputs: inventory.artifacts, dependencies: inventory.dependencies
}
```

After completion, parent creates a wrapper containing the manifest's fields
plus `originalReceipt: await fileReceipt(originalWorkerReceiptPath)` and
`outputManifestReceipt: await fileReceipt(publishedManifestPath)`. Pass that
wrapper as preparation `receipt`. The runner parses and validates the original
worker receipt: `state=completed`, `exitCode=0`, `sourceUnchanged=true`, clean
`sourceAfter` matching exact commit/tree and lockfile, identical `sourceBefore`,
measurement-root `cwd`, and exact original `workerCommand`. The manifest SHA256 must occur in that
worker's recorded `artifacts`; its contents must exactly match the wrapper.
Every output and dependency SHA256 must reconcile with the current inventory.
Failed, stale, unrelated or merely hashed receipts cannot qualify. This trusts
the authorized preparer's fresh-build attestation and scheduler evidence; it
is not a cryptographic proof that a compiler executed particular source.

## Admission, execution and completion

Parent reviews protocol, harness commit and byte digest, exact source/runtime/
fixture identities, and premeasurement criteria. Obtain exclusive **physical
host** admission through the registered custom WASM workflow; the native Cargo
prepared wrapper does not support this protocol. PC timing remains disabled.
Do not nest reservations or recover an uncertain submission by resubmitting.

Use scheduler probes with timestamped Linux **and host** CPU, memory, process
and ownership evidence before/during/after the cohort, with no unrelated
runnable work. Freeze the probe commands, interval and exclusivity requirements
in the approval record. Runner load/free-memory snapshots are observations,
not idle certification. Missing or adverse probes cannot qualify. Admission JSON
is a parent attestation referencing actual evidence, not an acquired lock:

```json
{
  "approvedProtocolSha256": "EXACT_REVIEWED_PROTOCOL_SHA256",
  "hostname": "EXACT_MEASUREMENT_HOSTNAME",
  "exclusiveReceipt": "/absolute/evidence/original-exclusive-admission.json",
  "preparation": {
    "base": { "inventory": "/absolute/evidence/base.inventory.json", "receipt": "/absolute/evidence/base.build-wrapper.json" },
    "branch": { "inventory": "/absolute/evidence/branch.inventory.json", "receipt": "/absolute/evidence/branch.build-wrapper.json" }
  }
}
```

Custom cohort invocation template, submitted on the same measurement host
outside any reservation (use the preparation task ID). The frozen parent-owned
cohort script must collect the required before/during/after host probes and run
the runner below within this single exclusive command; it must not launch
another reservation. Freeze actual script/artifact paths and resource bounds
before measurement. These illustrative bounds do not replace the approved
idle, probe, identity, statistical or coverage requirements:

```bash
~/build-workers/run-heavy --cwd /absolute/harness --kind benchmark \
  --storage-task UNIQUE_COHORT_TASK --cpu 4 --memory 16 --timeout 86400 \
  --artifact /absolute/task-output/cohort/result.json \
  --artifact /absolute/task-output/cohort/proofs.jsonl \
  --artifact /absolute/task-output/cohort/host-probes.jsonl \
  -- bash /absolute/preparation/run-cohort-with-probes.sh
```

Only within that parent's exclusive command:

```bash
node /absolute/harness/scripts/perf/diff-e2e.mjs run \
  --protocol /absolute/evidence/protocol.json --admission /absolute/evidence/admission.json \
  --base-root /absolute/base --branch-root /absolute/branch \
  --fixture-root /absolute/fixtures --out /absolute/task-output/cohort
```

Output must be new and outside measured roots. `result.json` is atomically
checkpointed per pair, completion and failure. `proofs.jsonl`, resolver logs,
`samples.jsonl` and bounded child `samples.log` retain evidence, including a
finished first arm when its partner fails. There is no resume/replacement mode.
Reconcile the original receipt/output before any new scheduling decision.

Bounds: 5–25 pairs, one million rows per side, 512 MiB per IFC, 1–10 repeats,
30 minutes per child, 12 GiB Node old-space and 256 KiB child output. The parent
launcher must additionally impose real process/host memory and deadline limits;
V8 old-space is not such a limit. Abort/timeout kills only the owned child.

Missing fixtures skip with `pnpm fixtures` instructions and make the cohort
incomplete (exit 2); empty/oversized files, zero rows, incomplete scans and
identity mismatches fail. No skipped or missing coverage can yield acceptance.
The 750k-row case is explicitly synthetic Haus expansion, not a large IFC
revision pair. The large case may use a **real large IFC plus a reproducible
controlled derived IFC revision**. Independently authored large revisions are
not required by #8042; an authored revision is also permitted. Label controlled
derivation honestly in the frozen evidence and report, without presenting it as
an independent authoring-tool revision or external ground truth.

Before measurement, parent review must require full STEP entity counts and
full `IfcObjectDefinition` counts for **both files**, separately from the
fingerprint row counts; author/source provenance; and SHA256 hashes of source
and output IFC bytes. For a controlled revision, also retain the exact
reproducible recipe, its SHA256, parameters/seed and tool versions. Freeze the
expected unchanged/added/modified/deleted and content-match distribution for
each option (including expected absence or zero matches), then reconcile the
untimed proof against it. Bind these evidence references into the reviewed
protocol bindings so approval covers the recipe and expectations as well as
the existing fixture receipts. These are parent-reviewed coverage obligations,
not an automatic harness acceptance verdict. Self-comparison alone cannot
qualify changed-path coverage; the large proof rejects unchanged-only results.

**Required future acceptance:** a separate real geometry-enriched pair exercising
split/merge and successor evidence, a real large IFC with an authored or
controlled derived revision meeting the evidence requirements above, and
the actual Rust fingerprint pipeline. CLI rows currently contain no geometry
hashes/AABBs/volumes. Missing coverage blocks full acceptance even when all
available samples match. Sidecars/UTF-16, lineage, initialization retry/failure,
opaque references and consumer compatibility also need separate actual-WASM
proof. Parent records a ledger verdict only after approved, accepted measurement.

Publish compact receipts, JSON, logs and inventories through the owning managed
storage task, reconcile outcomes, close the task, and release generated
workspaces. Preserve original receipts and failed/contaminated evidence.

Fast harness-only checks (no real fixtures, production engines or measurements):

```bash
node --test scripts/perf/diff-e2e.test.mjs
```

The existing CI `scripts/perf/*.test.mjs` catch-all runs these tests. Tests use
behavioral fixtures and injected modules, never assertions on other source text.
