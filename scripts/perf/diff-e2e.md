<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Right-sized diff end-to-end protocol (#8042)

Protocol v3 supersedes the frozen 25-pair protocol. It measures six paired
rounds, seed 8042, with exactly three base-first and three branch-first rounds
in randomized order. There are three cases and two primary endpoints per case:
**72 timing children plus six untimed proof children**, rather than 1,200 timing
children. Use supported Node 22.13+ (22.x) or 24.x.

Cases: the demo revision pair, AC20-FZK-Haus self-comparison, and the preserved
large controlled revision pair. The large head SHA256 is enforced:
`f8e748cf1f2128609257c939aac9df40c6f62f70bbca6813ff5a67bb06ac853a`.
Both large file paths and receipts are bound before measurement. Keep its
existing source/recipe/expected-output evidence; do not regenerate it. The
750k synthetic expansion is removed. The single timed public-call configuration
has content matching, split/merge and successor detection enabled. CLI rows
are data-only; this is not a geometry coverage claim.

Each cold observation is a fresh process: imports, initialization, file reads,
parse, fingerprint build, public diffModels (including marshaling, restoration
and handle release), input release and GC are measured continuously. Each warm
observation is a separate process with retained JS fingerprints, one conditioning
call and three timed calls. Calls still construct and free handles through the
public facade. Warm repetitions stay in that process; their median is one
observation, never three independent samples. Fingerprint construction and final
release remain in the warm lifecycle report, outside warm call latency.

Proofs run separately before timing and retain all three original option
configurations, including disabled versus enabled optional results. Full input/output hashes, Map order,
optional-versus-empty/absent values, secondary claims, original row references
and byKey entry identity remain a **hard gate independent of timing**. Hashing
and resolver auditing never enter timing children. Source, binary, runtime,
fixture and preparation receipt checks remain intact. Missing large fixtures
make a full cohort incomplete; a smoke run cannot pass performance acceptance.
The Rust arm must expose the final public facade and actual Node WASM resolver;
do not infer implementation from the harness branch name. Inspect the public
entry point and select a TS commit before cutover as base; the sample rejects
a Rust facade masquerading as the TS arm. Prepare a clean public-cutover source
as the measured branch.

## Timing verdict fixed before measurement

Report each endpoint's median paired branch/base ratio and a pointwise 95%
paired percentile bootstrap CI (10,000 resamples, seed 8042). Resample complete
process pairs, not repeats. No Holm24 procedure or familywise speedup claim.

- A lower CI bound above 1.10 means a supported regression.
- A clean pass requires every upper CI bound at most 1.10.
- An interval crossing 1.10 is inconclusive, not a pass.
- Per-arm `(max-min)/median` spread above 20% flags noisy and blocks a clean pass.
- Identity failure, failed admission, skipped coverage or child failure blocks
  acceptance. Preserve all samples; do not replace inconvenient observations.

Six pairs give limited precision; no result promises a decisive verdict. Record
the measured verdict and lesson in `scripts/perf/README.md` before consumer
cutover. `fullIssue8042Accepted` remains false because separate geometry,
consumer and other correctness obligations are outside this timing cohort.

## Plan, smoke and host observations

```bash
node scripts/perf/diff-e2e.mjs plan --out /absolute/evidence/draft.json \
  --large-base /absolute/frozen/source.ifc \
  --large-head /absolute/frozen/controlled-revision.ifc
```

Defaults are six pairs, seed 8042 and three retained calls. A bound full plan
also needs `--bindings /absolute/evidence/bindings.json`. Bindings retain runtime,
harnessSource, hostname in measurement, harness digest, base/branch inventory
digests and fixture receipts. The runner rejects changed bindings. There is no
per-process classification requirement and no periodic whole-host shell probe.

Use standard registered exclusive physical-host admission and its idle check
at the start. Runner records timestamped load averages, free memory and CPU
counters before/after every round, for reporting rather than automatic process
classification. Do not change services or timers. Run on Pop; PC benchmark
admission remains disabled. Do not use the native-only `ifc-benchmark` wrapper.

A one-pair small-fixture smoke runs as **ordinary validation**, with no timing
acceptance or fabricated exclusive/preparation receipts:

```bash
~/build-workers/ifc-fleet run --host pop-os --kind ordinary \
  --storage-task issue8042-rightsized-smoke --cwd /absolute/clean/harness -- \
  node scripts/perf/diff-e2e.mjs dry-run --base-root /absolute/prepared-ts \
  --branch-root /absolute/prepared-public-rust --fixture-root /absolute/fixtures \
  --out /absolute/task-output/smoke \
  --large-base /absolute/frozen/source.ifc \
  --large-head /absolute/frozen/controlled-revision.ifc
```

It executes real proof children and cold/warm children on demo and Haus, checks
identity and writes `dry-run.json`, including wall and per-pair process costs.
The optional large paths are statted only for a byte-linear planning projection;
they are never parsed by the smoke. `planning` records the assumption, full
estimate and twice-estimate timeout rounded up to a minute.
It does not require full-cohort preparation inventories, does not audit resolver
coverage, and never produces a performance verdict. This distinction keeps a
small functional smoke possible without weakening measurement admission.

Budget the full cohort from the smoke's process costs and its explicitly stated
scale assumption for the large case and proof cost. Target under two hours;
set the launcher timeout to `planning.timeoutSeconds` (twice the estimate).
The validated small-fixture smoke receipt and planning projection are retained
separately; the command below uses its projected 12,240-second timeout. Recompute
it for a materially changed source or fixture plan. A timeout is a failed cohort,
never permission to remove the large case. Do not run the full cohort during harness implementation.


Implementation smoke evidence: ordinary Pop job
`f6a71d44-90d6-4468-946e-4d17af8d8092`, harness commit `20fd70b2ad`, TS source
`e59777a81424ef44210b9f093c989d5db2c57e59`, Rust source
`514a5f21233265118ab7393f357e186bf237d350`. The report preserves real fixture
receipts, all option proofs, raw child costs, the byte-linear size assumption
and its timeout projection. This is functional harness evidence, not an
exclusive performance verdict. New full-cohort preparation must bind the
intended current source pair; the smoke's old source pins are not approval
for another source pair.

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
These templates assert no preparation or acceptance result.

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

## Exclusive execution and completion

After admitted source-pinned ordinary preparation, freeze bindings and approve
that exact protocol hash. Admission JSON remains:

```json
{
  "approvedProtocolSha256": "EXACT_PROTOCOL_SHA256",
  "hostname": "pop-os",
  "exclusiveReceipt": "/absolute/evidence/original-exclusive-admission.json",
  "preparation": {
    "base": { "inventory": "/absolute/evidence/base.inventory.json", "receipt": "/absolute/evidence/base.build-wrapper.json" },
    "branch": { "inventory": "/absolute/evidence/branch.inventory.json", "receipt": "/absolute/evidence/branch.build-wrapper.json" }
  }
}
```

On Pop, outside any reservation, use one task for preparation and measurement:

```bash
~/build-workers/run-heavy --cwd /absolute/clean/harness --kind benchmark \
  --storage-task issue8042-rightsized-cohort --cpu 24 --memory 48 --timeout 12240 \
  --artifact /absolute/task-output/cohort/result.json \
  --artifact /absolute/task-output/cohort/proofs.jsonl \
  -- node scripts/perf/diff-e2e.mjs run \
  --protocol /absolute/evidence/protocol.json --admission /absolute/evidence/admission.json \
  --base-root /absolute/prepared-ts --branch-root /absolute/prepared-public-rust \
  --fixture-root /absolute/fixtures --out /absolute/task-output/cohort
```

Paths above must be the actual frozen prepared paths. Admission is an attestation
referencing the registered launcher's real exclusive/idle receipt; the JSON does
not acquire a lock. Original receipts must be reconciled after interruption,
never resubmit an unknown outcome. Outputs are new and outside source roots.
The runner checkpoints each pair and preserves failed proof/timing evidence.
Child limits: ten minutes, 12 GiB old-space, 256 KiB log; the launcher additionally
bounds physical memory and total time. Missing fixtures instruct `pnpm fixtures`
and make the full run incomplete. The frozen large head hash is a hard gate.

Publish compact receipts, JSON, logs and inventories through managed storage,
close the owning task after reconciling all outcomes, and release generated
workspaces. Preserve foreign source, fixtures, evidence and locks.

Fast behavioral harness checks (also reached by CI's perf test catch-all):

```bash
node --test scripts/perf/diff-e2e.test.mjs
```
