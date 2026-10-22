# Performance Benchmarking Guide

This directory contains performance benchmarks for IFC-Lite geometry processing and rendering.

## Structural GPU count cohorts (#6993)

Set `VIEWER_BENCHMARK_GPU_UPLOADS=1` before running the viewer benchmark to
use per-mesh streaming fragments instead of time-dependent grouping. Each
flush is bounded by mesh count and index volume. The harness pins four
geometry workers and, unless explicitly overridden, fixed-size geometry jobs.
Run both FZK and Snowdon twice with the same build and settings and compare
the GPU allocation and `gpu.staticUpload` count/byte counters. The aggregate
`gpu.writeBytes` also includes mutable table updates and remains scheduling
dependent. Retain device-loss samples as
invalid observations; they cannot establish repeatability.

Count results carry `environment.uploadMode: "count"` and are written to
`benchmark-count-results/`. They describe a different transient upload
workload and cannot establish a latency win. The timing comparison, baseline
writer and cold A/B harness refuse count-mode samples. Normal runs keep the
time-budgeted policy. The viewer URL equivalent is
`?perfTrace=1&geomWorkers=4&perf.benchmarkUploads=1`.

## Quick Start

### Run Default Benchmark

```bash
# Build viewer first
pnpm --filter viewer build

# Fetch one small fixture on demand (fixtures come from a GitHub Release,
# see tests/models/manifest.json — the repo no longer uses Git LFS)
node scripts/fixtures/fetch-fixtures.mjs "ara3d/AC20-FZK-Haus.ifc"

# Run a single small benchmark (headed browser for accurate GPU timing)
VIEWER_BENCHMARK_FILES="tests/models/ara3d/AC20-FZK-Haus.ifc" pnpm test:benchmark:viewer
```

### Run Additional Models

```bash
VIEWER_BENCHMARK_FILES="tests/models/ara3d/AC20-FZK-Haus.ifc" pnpm test:benchmark:viewer
```

You can provide a comma-separated list, but only after fetching the exact fixtures you want to test.

### Optional Stress Tests

The largest fixtures are intentionally opt-in because of their download size:

```bash
node scripts/fixtures/fetch-fixtures.mjs "various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc" "ara3d/ISSUE_053_20181220Holter_Tower_10.ifc"
VIEWER_BENCHMARK_FILES="tests/models/various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc,tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc" pnpm test:benchmark:viewer
```

### Check for Regressions

```bash
# After running benchmarks, check against baseline
pnpm benchmark:check
```

## Test Models

The benchmark suite includes 4 models covering different scenarios:

| Model | Size | Purpose | Key Metrics |
|-------|------|---------|-------------|
| **FZK-Haus** | 2.4MB | Cutout/boolean testing | Window/door openings must be visible |
| **Snowdon Towers** | 8.3MB | Structural elements | Fast loading baseline |
| **BWK-BIM** | 326.8MB | Large architectural | Optional stress test for streaming |
| **Holter Tower** | 169.2MB | Complex geometry | Optional stress test for crash prevention (MAX_OPENINGS safeguard) |

For day-to-day work, prefer `FZK-Haus` or `Snowdon Towers`. Reserve `BWK-BIM` and `Holter Tower` for intentional stress testing.

## Baseline Policy: the committed baseline is CI-recorded

The committed `baseline.json` holds numbers recorded on the CI runner
(GitHub-hosted `ubuntu-latest`, headless Chrome, SwiftShader, production
build) so the CI regression check diffs like-for-like. Local machines are a
different speed class — **never commit locally recorded numbers**.

### Refreshing the committed baseline

1. Dispatch the **Benchmark** workflow on `main` with `record_baseline`
   enabled (`gh workflow run benchmark.yml -f record_baseline=true`).
2. Download the `benchmark-baseline` artifact from the run.
3. Commit the refreshed `tests/benchmark/baseline.json` via a normal PR.

Only the two CI fixtures (FZK-Haus + Snowdon) are refreshed this way; the
BWK-BIM / Holter Tower entries only serve local stress runs and keep the
machine noted in their `environment` field.

### Local scratch baselines

To compare your own before/after runs at local machine speed, record and
check against an uncommitted scratch baseline:

```bash
VIEWER_BENCHMARK_FILES="..." pnpm test:benchmark:viewer
BENCHMARK_BASELINE=/tmp/my-baseline.json node scripts/update-benchmark-baseline.mjs
# ...make changes, rerun the benchmark...
BENCHMARK_BASELINE=/tmp/my-baseline.json pnpm benchmark:check
```

## Metrics Captured

Primary metrics captured in the current benchmark log format:

- **firstBatchWaitMs**: Time until first geometry appears (user-perceived speed)
- **totalWallClockMs**: End-to-end load time for the model
- **totalMeshes**: Total mesh count (geometry correctness check)
- **fileSizeMB**: Model size used for comparisons
- **wasmWaitMs**: Total WASM processing wait time during geometry streaming
- **entityScanMs**: Fast entity scanning time
- **dataModelParseMs**: Data model parse time

Each result JSON also carries two #6993 blocks:

- **`gpuHealth`**: whether the sample lost its WebGPU device. `contaminated`
  is true when the renderer's device was lost (`gpu.deviceLost`, or the
  renderer's `[WebGPU] Device lost` line with any reason but `destroyed`) or
  replaced by its own renderer (`gpu.deviceReplacements`, the recovery path
  that re-uploads the scene; two live renderers are not a replacement). The counters are session totals, so a loss before the load window
  opens counts too. `benchmark:check` excludes a contaminated sample instead
  of comparing it and says so at the top of the report; when every model is
  contaminated it reports "No verdict" and exits 0, because a runner's lost
  GPU is not a harness fault. `update-benchmark-baseline.mjs` never records
  one (all contaminated: every previous entry is kept, exit 0), and the
  cold A/B (`scripts/perf/browser-cold-ab.mts`) records it as a failed sample.
  Uncaptured errors and Dawn `Instance reference no longer exists` lines are
  kept as evidence only when no device-loss witness accompanies them. The
  message alone does not identify the affected device. In particular,
  `reason: destroyed` does not prove application teardown: Chromium also
  destroys devices when its GPU channel fails (#7655).
- **`interactionCommits`**: React commits caused by one hierarchy-row select,
  one pointer move onto the viewport centre and opening the Lens panel, each
  measured from a quiet page to the next quiet point after every timing has
  been taken. These counts repeat exactly between runs; per-load
  `react.commits` does not.

The loss is frequent on software GPUs. In the 20 main-branch Benchmark runs
before 2026-10-11 on GitHub's ubuntu SwiftShader runner, FZK-Haus lost its
device in 11, Snowdon in 15, and both in 8, so until #7164's root cause is
fixed each fixture is compared in only about half the runs. Locally on WSL
SwiftShader, FZK lost it in 7 of 9 fresh-page loads and Snowdon in none of 4;
refusing WebGL in the page (FZK shows a WebGL minimap) still lost it in 1 of
4, so the minimap is not the whole cause.

The #7655 isolated reproduction traced a failure to the launch configuration:
`--use-vulkan=swiftshader` selected the WebGPU backend while default ANGLE
failed to open an X display. Acquiring a canvas texture then failed Chromium's
shared-image allocation and closed the GPU channel. Selecting
`--use-angle=swiftshader` as well preserves pipeline creation, queue completion
and exact GPU-buffer readback. The renderer now distinguishes intentional
teardown by ownership lifetime, so browser-initiated destruction is recovered
and counted. Historical loss counts that excluded every `destroyed` reason
can undercount failures; they are not proof of healthy GPU execution.

The `Browser frames (deterministic rig)` workflow has explicit dispatch modes:
`instance` runs the isolated original/fixed comparison; `diagnostic-frames`
captures device identities and browser stderr; `qualification-frames` runs
five normal FZK/Snowdon cohorts against one build and retains every attempt.
Diagnostic frame output is rejected by performance admission. The isolated
probe is `scripts/perf/diagnostics/swiftshader-instance.mts`; it requires the
Playwright headless shell and no viewer build or IFC fixture. See the initial
[hosted reproduction](https://github.com/LTplus-AG/ifc-lite/actions/runs/39803660353).

## Geometry Correctness Validation

The benchmark suite includes mesh count validation to detect geometry regressions:

- **Expected mesh counts** are defined in `viewer-benchmark.spec.ts`
- **Tolerance**: 5% variance allowed
- **Warning**: Logs warning if mesh count differs significantly (may indicate missing cutouts)

## Performance Targets

Reference numbers from a local (Apple Silicon) run on 2026-02-21 — these are a
speed-class illustration, not the committed CI baseline:

| Model | First Geometry (`firstBatchWaitMs`) | Total Time (`totalWallClockMs`) | WASM Wait (`wasmWaitMs`) | Meshes |
|-------|--------------------------------------|----------------------------------|---------------------------|--------|
| FZK-Haus | ~202ms | ~0.25s | ~14ms | 244 |
| Snowdon | ~217ms | ~0.59s | ~292ms | 1,556 |
| BWK-BIM | ~5.43s | ~11.89s | ~2.98s | 39,146 |
| Holter | ~3.05s | ~11.04s | ~5.60s | 108,551 |

## CI Integration

`.github/workflows/benchmark.yml` runs on PRs that touch performance-relevant
paths: it builds the viewer (production), benchmarks FZK-Haus + Snowdon with
the `viewer-benchmark-ci` Playwright project, and posts the per-metric delta
vs `baseline.json` as a sticky PR comment + step summary. The job is
**advisory** — it reports regressions but never fails the PR (promote to
blocking once runner noise is characterized). `VIEWER_BENCHMARK_ADVISORY=1`
is what keeps the spec's own threshold check from failing the run there.

To reproduce the CI mode locally:

```bash
node scripts/fixtures/fetch-fixtures.mjs "ara3d/AC20-FZK-Haus.ifc"
VIEWER_BENCHMARK_FILES="tests/models/ara3d/AC20-FZK-Haus.ifc" pnpm test:benchmark:viewer:ci
```

This runs headless Chrome with software rendering (`--use-angle=swiftshader`) and is useful for reproducible CI-style timing checks.

## Troubleshooting

**Benchmarks fail with "No baseline available"**:
- Fetch the fixtures you want to baseline, then run `VIEWER_BENCHMARK_FILES="..." pnpm test:benchmark:viewer` and `node scripts/update-benchmark-baseline.mjs` (use `BENCHMARK_BASELINE=...` for a local scratch baseline)

**Performance regressions detected**:
- Check if optimizations broke geometry (mesh count validation)
- Profile WASM with browser DevTools Performance tab
- Compare console logs between baseline and current run

**Geometry correctness warnings**:
- Verify cutouts are visible in FZK-Haus model
- Check if MAX_OPENINGS safeguard is skipping too much
- Ensure CSG operations complete successfully
