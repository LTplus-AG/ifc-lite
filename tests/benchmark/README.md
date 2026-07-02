# Performance Benchmarking Guide

This directory contains performance benchmarks for IFC-Lite geometry processing and rendering.

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
