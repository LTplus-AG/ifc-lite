# Flag-on qualification

Before a perf flag can default to on (`apps/viewer/src/lib/perf/flags.ts`: a
ramp must be default-on or deleted within four weeks), the viewer has to
behave with it forced on. `flag-qualify.mjs` checks that for one flag set and
prints one pass/fail table, with an evidence path on every row.

Every stage compares the flags-on run with a flags-off run of the same build.
A check that also fails flags-off is main's defect: it is listed as `skip`
with the reason, never blamed on the flag.

Manual tooling, not wired into CI (the `scripts/perf/` carve-out). Its pure
parts are unit-tested by `flag-qualify.test.mjs`, which CI runs with the other
`scripts/perf` tests.

| file | role |
|---|---|
| `flag-qualify.mjs` | CLI: `unit`, `e2e`, `gpu`, `dist`, `report` |
| `flag-qualify-lib.mjs` | flag sets, boot script, flagged build, PNG/pixel statistics, arm comparison, table |
| `flag-qualify-gpu.mjs` | one arm on a real GPU: load, memory, views and interactions, frames |

## Flag sets

`--flags` takes a registry flag id, a preset or a spec. A flag id
(`drawStream`, `gpuInstancing`, ...) sets the URL param and the global of its
inline `bindings` in `apps/viewer/src/lib/perf/flags.ts` to `1`, so a new flag
needs no edit here. The preset `drawStream-full` adds the arena and HLOD. A spec
is `name=value,...`: a `__IFC_LITE_*` name sets that page global (JSON value,
commas allowed), any other name a URL param.

**How a flag is forced.** In the browser, a flagged view of the build (links
to its files, and a patched `index.html`) gets a first `<head>` script that sets the globals and merges the
params into the URL (`history.replaceState`) before the app boots, so every
binding the registry reads (global, URL param, sticky key) sees it, on every
page a test opens. The script records what it forced on
`globalThis.__IFC_LITE_QUALIFY_FLAGS__`; the `gpu` stage fails a run where it
did not. The unit suite has no URL, so it is forced through a Node `--import`
preload that sets the globals only; a param-only set is skipped there.

## Stages

```bash
Q=/tmp/qual   # output root; each flag set gets Q/<label>/

# Viewer unit suite with the flag globals preloaded (CPU; fleet):
node scripts/perf/flag-qualify.mjs unit --flags drawStream --out $Q --shards 4 --build-deps

# Playwright e2e against the flagged build (needs a built viewer and Chrome):
node scripts/perf/flag-qualify.mjs e2e --flags drawStream --out $Q --dist apps/viewer/dist --project viewer-e2e-ci

# GPU: real models, interactions and the pixel gate (real GPU only):
~/build-workers/ifc-fleet run --route fleet --gpu --host pc-wsl --strict-host --cwd "$PWD" -- \
  node scripts/perf/flag-qualify.mjs gpu --flags drawStream --out $Q --dist /abs/viewer-dist \
    --models samples,real,campus-100k --real-dir /abs/real-models --models-dir /abs/generated

node scripts/perf/flag-qualify.mjs report --flags drawStream --out $Q   # Q/<label>/report.md; GPU rows recomputed from the saved frames
```

`unit` and `e2e` run the flags-off suite only when the flags-on run fails, and
list the failures the flags-off run does not have. `e2e` serves each arm with
`vite preview --outDir` on a free port (Playwright reuses a server already on
`PLAYWRIGHT_PORT`) and sets `E2E_GPU_STRICT=0` as CI does.

`gpu` models: `samples` (hello-wall, building-architecture, infra-bridge, FZK
and `federation` = building-architecture + its rev-b, all committed),
`real` (whichever of Holter, advanced_model, skolebygg and TFS are in
`--real-dir`; never committed), a single name, `campus-<tier>` (the
huge-geometry generator's mixed-campus, written to `--models-dir`) or
`name=path[+path]`. Results accumulate in `gpu.json`, so models can be split
across GPU slices of 15 minutes or less.

## What the `gpu` stage checks

Per model, the off arm and then the on arm load in a fresh Chrome through the
viewer's canonical file input, wait for the settled scene and run the same
script. Each step saves a renderer readback (`__ifc_lite_capture_color_frame__`,
three reads at an idle renderer with the mouse off the canvas):

| step | area | what is compared |
|---|---|---|
| home, far (4x zoom out: LOD1 and far field), top | render, LOD | pixels |
| pick (three canvas clicks) | pick | picked ids, pixels (highlight) |
| hide 30%, isolate 10% (sorted id sample) | hide/isolate | counts, pixels |
| colour 20% | colour override | pixels |
| section | section | pixels |
| export | export | GLB size and SHA-256 (command palette, real download) |
| device-loss | device loss | recovery to a settled scene, pixels after recovery |

Plus: the load completes, the flag was forced, and diagnostic single-sample
no-regression checks of first frame, interactive time, GPU bytes and JS heap
(`small-model` rows for the committed models). These numbers are never timing
evidence: an A/B needs the exclusive benchmark admission (fleet policy).

Model compare has no renderer path of its own; it is covered by the e2e stage
(`compare-impact-6921`, and the federation model here).

**Pixel gate.** A step passes when at most `--pixel-max-pct` (default 0.1) of
the pixels differ by more than 8/255 between the arms. With `--noise` a second
flags-off arm loads too (reported as `main vs main`). A step where main differs
from itself by more than the gate is inconclusive (`skip`), unless the flag
differs by more than twice that plus the gate; failing steps get a diff
image (`diffs/`, differing pixels in red). Main draws the same frame on every
load up to 0.05% of isolated pixels (mixed-campus 100k, RTX 5070 Ti). The
residue is the model's shared frame origin, which the first batch created sets:
a different origin moves the f32 vertex positions by a rounding step, which
shifts single sub-pixel edges and, rarely, a vertex across a LOD1 cell edge.
Before the LOD1 election became load-order independent, main differed from
itself in 5.1% of pixels.
