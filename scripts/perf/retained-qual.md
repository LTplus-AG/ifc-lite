<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Retained qualification runners (#7955 item 6)

Runners for the retained-kernel measurements the qualification plan lacked:
viewer time to first retained frame, the built Node `ifc-lite export` retained CLI,
browser memory and native worker memory. They only measure; the cohort, its frozen
SHA and its exclusive admission are the submitter's. **All retained numbers are
report-only: no retained performance or memory threshold is registered.** The
default-path A/B stays `scripts/perf/ab.sh` + `ab-report.mjs`, untouched.

| Runner | Measures | Fresh per sample |
|---|---|---|
| `retained-qual-viewer.mjs` | `?kernel=retained` load of a model through the real `#file-input-open` (canonical `loadFile`) to the **first rendered frame containing retained geometry**, then to the terminal load state and rendered complete geometry; Chrome-tree memory; `measureUserAgentSpecificMemory` | Chrome process and profile |
| `retained-qual-cli.mjs` | `node packages/cli/dist/index.js export --format obj --kernel retained`, wall time with a same-round `--version` startup control, process-tree RSS/HWM, output identity (OBJ SHA-256) | Node process |
| `retained-qual-browser-memory.mjs` | One model through the real `RetainedModelSession` over the staged engine: retained WASM heap (start / maximum observed / end), UA memory before/after, Chrome-tree HWM/RSS/PSS | Chrome process and page |
| `retained-qual-native-memory.mjs` | One `retained_compare` run under `/usr/bin/time -v` with 50 ms polling of its descendant `ifclite_smlib_worker` VmRSS/VmHWM | native process set |
| `retained-qual-report.mjs` | Paired base/branch rows, ab-report criteria, no verdict | — |

Library and checks: `retained-qual-lib.mjs` (identity, statistics, arms),
`-proc.mjs` (the /proc sampler), `-browser.mjs` (Chrome, preview, GPU evidence),
`-assert.mjs` (the retained-used assertions), `-viewer-page.mjs` /
`-browser-memory-page.mjs` (page-side code). Unit tests (`*.test.mjs`, no browser,
engine or fixture needed) run in the existing `scripts/perf/*.test.mjs` CI step.
The runners themselves need a built checkout, a staged engine and (viewer, browser
memory) Chrome, so they are manual and are **not** in required CI.

## Fail, not skip

Every sample is verified before it can be a timing; a failure is a row with `ok:false`
and an `error`, listed in `result.failures`, excluded from summaries, and makes the
runner exit 1. There is no soft path.

- **Viewer**: the store model carries `retainedGeometry` with `kernel: 'retained'`, no
  `failure`, `started`, `candidates > 0`, `published > 0`, `published + unpublished ==
  candidates`, store meshes > 0, `loadState: 'complete'`; requests include `/smlib/` and
  `/retained-engine/pkg-retained/`; no `cache.lookup` span; the manifest the preview
  *serves* hashes to the staged engine's; no WebGPU device loss. A build without
  `VITE_RETAINED_GEOMETRY=on` loads exact, has no `retainedGeometry`, and fails here.
- **CLI**: exit 0, empty stdout, report format/`kernel: retained`, the report's engine
  manifest hash equals the staged one, `published + sum(byCode) == candidates`, the
  stderr summary matches the report, the OBJ header says `# kernel: retained` with a
  final or shape-only marker.
- **Native**: `summary.json` of the executable is complete, violation-free, has a
  finite nonnegative numeric `retained.milliseconds` duration and published products, and at least one SMLib worker process
  was observed.
- **Browser memory**: the session starts, the page's event tally equals the session
  summary, the served manifest is the staged one.
- Optional `--expect pins.json` (`{"/absolute/path/model.ifc": {"candidates": N, "published": M}}`,
  taken from a prior correctness run) pins counts by the resolved full fixture path
  (never its basename, so identically named files remain distinct); the cohort must pin them. A file may also be
  per side for CLI, viewer, and browser-memory, `{"base": {...}, "branch": {...}}`, when the arms legitimately publish different counts
  (a pin never falls back to the other side). With `--expect`, missing or invalid
  pins for any arm/fixture pair fail at startup, before engines or samples start. Native-memory instead accepts a direct
  count object: `{"candidates": N, "published": M}`. Its `--summary` must name a
  fresh per-run path; an existing file is rejected before the command starts.

## The first retained frame

All times are the page's `performance.now()`, reported as milliseconds from the file
input's `change` event (observed in the capture phase, before the viewer's handler),
which is the `loadFile` invocation; the load trace's own start rides along as
`loadTraceStartOffsetMs`.

| Column | Meaning |
|---|---|
| `productMs` | the store first holds a retained model with `published > 0` and a mesh. **Not a frame.** |
| `sceneHeldMs` | upper bound on scene ownership: the first retained drawing frame's timestamp |
| `firstRetainedFrameMs` | `FrameStats.timestamp` of the first completed drawing frame after retained publication in the fresh scene. Under `kernel=retained` every mesh is retained, so a draw call is a retained draw |
| `terminalMs` | not loading, `loadState: 'complete'`, completeness not `running` |
| `settledFrameMs` | first completed frame after `terminalMs` and the first frame that drew with resident GPU bytes unchanged since the previous tick. The renderer draws on demand, so it may not exist; the row then holds `null` and `settledNote`, never a guess |

Observe completed frames after each animation callback, using the renderer's own
timestamp. No scene geometry is copied. Scene ownership is bounded by the drawn
frame, rather than timestamped at a later polling tick.

## Memory, and what it cannot say

- Native: the maximum observed individual worker HWM and maximum observed concurrent
  worker RSS sum, the executable's own max RSS and the executable's `summary.json`
  (its getrusage fields are process-lifetime high water, reaped children only). Never
  total-system RSS; sampling can miss a short-lived worker.
- Node CLI: the Node process tree. Node uses its own WASM/worker transport; do not
  quote it as native worker RSS.
- Browser: `wasmHeapMaxObservedBytes` is a maximum *observed* at module load, each
  product event and the end, not an allocation-exact peak. The SDK's private Worker
  linear heap is `null` with its reason. Source-buffer duplication is not observable from
  the page and is `null` with its reason. `measureUserAgentSpecificMemory` is
  aggregate and worker-inclusive; `--require-ua-memory` makes its absence a failure.
  Chrome-tree figures sum RSS (which double-counts shared pages) and also record PSS.

## Output

`--out DIR` receives `runs.jsonl` (one row per sample, the `scripts/perf/ab-report.mjs`
convention: `side` `base|branch`, `path`, `round`, `*Ms` phases, integer counts),
`runs.partial.jsonl` (appended as samples finish) and `result.json`:

```
schema ifc-lite.retained-qual/1, kind, reportOnly, performanceVerdict, exclusivity,
startedAt/finishedAt, host {hostname, kernel, cpuModel, cpuCount, memTotalBytes, node,
machineIdSha256, loadAtStart}, commit, engineManifestSha256, arms [{side, commit, dirty,
engineManifestSha256, sdkRevision, engineAssets, servedDist | cliEntrySha256}],
fixtures [{path, bytes, sha256}], order, rounds, samples, rows, failures, summary
{<side>/<path>: {columns: {col: {n, median, min, max, spreadPct}}}}
```

The viewer runner records per-row GPU adapter, browser version, `softwareAdapter`, `webgpuDeviceLosses`, worker
count (`hardwareConcurrency`), fixture hash and served-dist digest are recorded. A
software adapter (SwiftShader) is named; viewer `--require-hardware-gpu` refuses it.
Browser-memory does not record adapter/software/device-loss fields and does not
support `--require-hardware-gpu`.

`exclusivity.exclusive` is **true** only inside an `ifc-fleet --kind benchmark` job
(`IFC_WORKER_KIND=benchmark`, the job id becomes the receipt) or when the submitter passes
`--exclusive-receipt ID`; the runner records `verified: false` (it cannot verify
admission) and refuses a flag that contradicts an ordinary job. Every other run,
including every smoke run, is a non-exclusive observation. `--require-quiet` refuses to
start while a `pop-quiet-window-*.json` is unreleased.

## Arms and rounds

One `--arm branch:/abs/checkout:/abs/engine` is an observation. One `base` and one
`branch` arm is a paired A/B: rounds interleave, and within each round the order comes
from `ab-order.mjs` (balanced, randomised, `--seed` replays it). The viewer starts one
`vite preview` per arm (ports from `--port-base`) from each arm's own
`apps/viewer/dist` built with `VITE_RETAINED_GEOMETRY=on`. `retained-qual-report.mjs
RUNS.jsonl|DIR` reads paired rows with the ab-report criteria (median; the base
spread is the noise floor; a movement is real only beyond `max(noise, 3%)` and 1 ms;
base total spread > 15% is too noisy; a zero baseline blocks; count drift voids
like-for-like) and prints numbers only. For the M11-I report-only viewer A/B use its
actual pre-I base and final head; the pre-M-series baseline has no retained consumer
and cannot be an arm.

## Real GPU on Pop

Headless Chrome returns the NVIDIA adapter but loses the device on the first canvas
present. Use `--gpu hardware --headed` on a **private** Xvfb (never `:0`/`:1`), with
`DISPLAY` set to it, and `--require-hardware-gpu`. `--gpu swiftshader` (default, the
`viewer-retained` e2e flags) is a software adapter and is labelled so in every row.

Reports preserve runner kind, host, commits, engine/binary identities and exclusivity.
Only unique successful samples from the same invocation and round are paired;
different workflows stay separate. Each column reports base, branch and matched n;
nullable coverage is marked incomplete and medians use matched finite rounds only.
Unavailable PSS stays null; coverage records readable/attempted process samples and
complete/partial tree samples. Partial trees never count as a measured total.

Cohort completeness is recorded in the result and portable JSONL provenance. An early
stop reports `expected N, got M`; an incomplete cohort makes both the runner and
reporter exit nonzero. Performance thresholds remain report-only.
