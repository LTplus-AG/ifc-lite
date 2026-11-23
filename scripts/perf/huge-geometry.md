# Huge-geometry stress harness

How does the viewer cope with very large amounts of geometry, and where does it
break? This harness generates seeded synthetic IFC models on a ladder of sizes,
loads each in a fresh Chrome on a real GPU through the viewer's one canonical
load path (`useIfcLoader.loadFile`, via the `#file-input-open` input), and
records load phases, memory, GPU submission, frame times along scripted camera
paths and interaction latencies. It climbs each scenario until a tier fails and
records how it failed. A recorder turns the same climb into a captioned video,
so spike branches can produce comparable before/after clips.

Manual tooling, not wired into CI (the `scripts/perf/` carve-out); its pure
parts are unit-tested by `huge-geometry-gen.test.mjs` and
`huge-geometry-report.test.mjs`, which CI runs with the other `scripts/perf` tests.

| file | role |
|---|---|
| `huge-geometry-gen.mjs` | generator CLI and library (deterministic, streams STEP) |
| `huge-geometry-shapes.mjs` | STEP writers: box, cylinder, mesh, voided wall, mapped prototypes |
| `huge-geometry-ladder.mjs` | scenario families, the tier ladder, parameter validation |
| `huge-geometry-run.mjs` | ladder runner CLI: per run JSON, `summary.json`, `summary.md` |
| `huge-geometry-browser.mjs` | fresh GPU Chrome per run, memory sampler, load with failure classification |
| `huge-geometry-measure.mjs` | settled memory, camera paths, pick / hide / isolate / section latency |
| `huge-geometry-page.mjs` | in-page probes (WebGPU draw and triangle counters, camera driver) |
| `huge-geometry-report.mjs` | frame statistics, ladder table, before/after table |
| `huge-geometry-compare.mjs` | compare two `summary.json` files |
| `huge-geometry-record.mjs`, `huge-geometry-video.mjs` | progress video with HUD |
| `huge-geometry-showcase.mjs` | SHOWCASE look: a city for footage (not a measurement family) |
| `huge-geometry-cinema.mjs`, `-cinema-path.mjs`, `-cinema-page.mjs` | cinematic clip per tier: full-frame canvas, camera path, feature beats |
| `huge-geometry-compose.mjs` | side-by-side before/after video (or a reel) from cinematic clips |

## Models

`node scripts/perf/huge-geometry-gen.mjs --scenario NAME --elements N --out DIR [--layout tower|campus] [--models K] [--repeat 0..1] [--tris T] [--seed S]`

Every element's geometry depends only on `(seed, global index)`, so output is
byte-identical for the same arguments, and a federated set (`--models K`) is the
single model sliced into K contiguous files with unique GlobalIds. IFC4 only.

| family | parts | what it stresses |
|---|---|---|
| `small-repeated` | 48-triangle meshes, all `IfcMappedItem` of 16 prototypes | instancing and dedup paths |
| `small-unique` | 48-triangle meshes, each unique (seeded jitter) | per-element overhead with instancing defeated |
| `dense-few` | tier / 50 unique ellipsoids of ~5k triangles | raw triangle volume |
| `mixed` | 35% slabs (box), 15% round columns (extrusion, kernel-tessellated), 10% walls with one opening (CSG), 30% instanced furniture (300 tris, 32 prototypes), 10% unique proxies (200 tris) | a realistic blend |
| `mixed-campus` | `mixed` over a ~2 km campus of 2,000-element buildings | culling |
| `mixed-fed4` | `mixed` federated into 4 models loaded together | federation |

`--repeat` overrides the instanced share of every part (0 defeats instancing,
1 maximises it); `--tris` sets the triangle target of every mesh part. Tiers:
10k, 100k, 250k, 500k, 1M, 2M, 4M nominal elements (`TIERS`). Generated files
are never committed; the `.json` manifest next to them records parameters and
counts, and an identical existing set is reused.

## Running the ladder

Prerequisites: `pnpm install`, `pnpm build:wasm`, `pnpm --filter viewer... build`
(heavy: run them through `~/build-workers/ifc-fleet run`). The runner refuses a
software adapter (SwiftShader, llvmpipe, fallback): WSL or SwiftShader numbers
do not count. On Pop, Playwright's bundled chrome-headless-shell with Vulkan
gets the NVIDIA adapter; do **not** set `VK_ICD_FILENAMES` to the NVIDIA ICD
(its GLX library fails headless and Chrome silently falls back to SwiftShader).

```bash
H=/path/outside/repo
# Generate only (light, single-threaded; keeps the exclusive slot for measuring)
node scripts/perf/huge-geometry-run.mjs --generate-only --out $H/run --models-dir $H/models \
  --scenarios small-repeated,small-unique,dense-few,mixed --tiers 10k,100k,250k,500k,1M

# Diagnostic climb (GPU, untimed admission; numbers are NOT benchmark evidence)
~/build-workers/ifc-gpu-check --limit 60 -- node scripts/perf/huge-geometry-run.mjs \
  --out $H/diag --models-dir $H/models --scenarios mixed --label baseline --evidence diagnostic

# Benchmark-grade climb: exclusive benchmark admission on Pop (nothing else runs)
~/build-workers/run-heavy --cwd "$PWD" --kind benchmark --timeout 10800 -- \
  node scripts/perf/huge-geometry-run.mjs --out $H/bench --models-dir $H/models \
  --label baseline --evidence benchmark --timeout-min 15
```

`ifc-gpu-check` caps a slice at 60 minutes and serialises GPU users; while
other lanes use the GPU, run one family per slice and retry only on exit 75
(the helper refused before running anything), for example:

```bash
for i in 1 2 3 4 5 6; do ~/build-workers/ifc-gpu-check --limit 60 -- node scripts/perf/huge-geometry-run.mjs \
  --out $H/diag --models-dir $H/models --scenarios dense-few --tiers 10k,100k,250k,500k,1M,2M,4M \
  --frames 240 --timeout-min 12 --label baseline --evidence diagnostic; [ $? -ne 75 ] && break; sleep 30; done
```

Slow tiers can outlast a slice: a camera path of 240 frames at 1-2 s per
frame takes minutes, so use `--frames 120` for the largest federated or campus
tiers. The result of each finished tier is saved before the next starts.

Inside a benchmark admission do not wrap the command in `ifc-gpu-check` (it is
refused while a benchmark owns the host). Never interrupt a running local
admitted job's client (see the fleet policy); let it finish or hit `--timeout`.
`--evidence` is only a label the runner records: pass `benchmark` only for runs
made inside exclusive admission.

Per run the runner records, in `runs/NAME.json`:

- load phases from the viewer's load trace (`?perfTrace=1`, the same probe as
  the load scoreboard): first frame, geometry complete, metadata ready, fully
  interactive, plus every span;
- memory: main-thread JS heap (CDP, peak during load and settled after a
  forced GC; `--skip-gc` skips that GC, which near V8's ~4 GB heap limit can
  itself kill the tab),
  PSS per Chrome process type (renderer = page + workers incl. their wasm
  heaps; GPU process), NVIDIA VRAM of the profile's processes, main-thread wasm
  memory, the renderer's resident scene GPU/CPU bytes;
- per frame during orbit / zoom / fly (240 frames each, exact poses from the
  home view): rAF frame time (median, p95, p99, worst; headless frames are
  paced at 60 Hz, so 16.7 ms is the floor), renderer CPU ms, draw calls,
  triangles submitted (WebGPU draw arguments), batches, instanced draws, culled;
- latency to the GPU finishing the next frame for: a pick click (5 points),
  hiding one element, isolating 10% of elements, `showAll`, and toggling the
  section plane on and off;
- note: for instanced models the viewer's `totalTriangles` (scene tris)
  counts each template once; the triangles actually submitted per frame are in
  `trianglesPerFrame`;
- failures, classified in this order: `renderer-crash` (tab killed, OOM or
  fault), `device-lost`, `out-of-memory` (allocation / wasm memory errors),
  `load-error` (viewer store error), `timeout` (with the spans still open),
  `page-error`. A pre-load memory warning is answered "Continue loading" so the
  climb reaches the real failure point.

`summary.md` has one row per run; `summary.json` carries the environment
(host, GPU, driver, git head and dirty flag, served `index.html` hash, load
average, evidence label).

## Recording a video

```bash
~/build-workers/ifc-gpu-check --limit 60 -- node scripts/perf/huge-geometry-record.mjs \
  --label baseline --models-dir $H/models --out $H/video --scenarios mixed --tiers 10k,100k,250k,500k,1M,2M
```

One WebM spans the whole climb (frames come from a CDP screencast of each fresh
tab into one ffmpeg: Playwright's bundled build, mjpeg in, VP9 out); an MP4 is
transcoded with gstreamer (`openh264enc`) when available. Per tier: a title
card, the load time-lapsed at 4x (the HUD shows real seconds), then orbit, zoom
and fly-through at real time with a live frame-time line, then a summary. A
failed tier shows its symptom and ends that scenario. A failed tier is followed by a verdict card from a fresh tab (a crashed
tab cannot render the HUD). Stills land in
`OUT/stills/LABEL-NAME-{loaded,summary,failed,verdict}.png`; `OUT/LABEL.json` holds
the numbers seen while recording. Recording runs a screencast, so its numbers
are diagnostic; take timings from the runner.

## Comparing a spike against the baseline

Rerun the same command on the spike's build with its own `--label` and output
directory, on the same host and with the same evidence grade, then:

```bash
node scripts/perf/huge-geometry-compare.mjs $H/bench/summary.json $H/bench-spike/summary.json --out $H/compare.md
```

The table pairs runs by name (`scenario-tier[-overrides]`) and shows status and
ratios for complete time, peak PSS, orbit/zoom/fly p95, pick and isolate.
Compare the videos side by side by label (`baseline.mp4` vs `SPIKE.mp4`).

## Showcase footage (cinematic clips)

Campaign videos must show a place, not a lattice. The SHOWCASE look is a
deterministic city made for footage, never for measurement:

`node scripts/perf/huge-geometry-gen.mjs --look showcase --elements N --out DIR [--seed S]`

A square spiral of 88 m blocks (streets with centre lines, street trees, parks)
holding towers on podiums, parallel bars, courtyard blocks and point towers,
heights falling off from the centre. Every storey of every wing has a slab, a
facade of mullions, spandrel and glazing panels, round columns, a core, a duct
and a pipe run and instanced furniture; roofs carry instanced plant. Colour
carries meaning: a hue per building, a light gradient up the storeys on the
spandrels, glazing tinted by the building hue, fixed colours per element type.
Exactly N elements, prefix-stable across tiers (the last building is cut off
at a storey), a single model, byte-identical per (N, seed). The manifest says
`look: showcase` and carries the recorder's block (hero tower ids, anchor
centres, pick target). The measurement families are untouched.

It is not `mixed-campus`: at the same element count it has about 8x fewer
triangles (mostly 12-triangle boxes; e.g. 1M elements: >= 13.1 M triangles vs
>= 102.6 M), 130 colour styles instead of 8 (more draw batches in today's
renderer), 11.5% instanced instead of 30%, half the file size, and thousands of
real buildings and storeys instead of one building of 20 storeys. Never quote
showcase footage as a measured configuration.

Record clips (one per tier; real GPU; the scene is generated on first use):

```bash
~/build-workers/ifc-gpu-check --limit 15 -- node scripts/perf/huge-geometry-cinema.mjs \
  --label LANE --models-dir $H/models --out $H/video --tiers 250k,1M
# optional: --dist apps/viewer/dist --query 'flagA=1&flagB=on'
# or, against a viewer served elsewhere: --viewer-url 'http://host:port/?flag=1'
```

Each clip: title card, the load time-lapsed (`--load-speed`, default 4x), then
the camera path with the canvas lifted to fill the frame: fly-in from far
out, orbit, dive to street level, a street glide, then feature beats (isolate
a hero storey, a horizontal section plane sweeping down through the city, a
colour override on the hero tower, a real mouse pick on a hero facade panel
with the picked element's class and name), and a pull-back; then a summary
card (or, after a failed load, the failure in the HUD and a verdict card).
The path is a pure function of the showcase manifest
(`huge-geometry-cinema-path.mjs`) and runs by time, not by frames: a slow
build shows fewer, jumpier frames of the same motion, and two clips of the
same tier stay in lock-step. IFC coordinates map onto the viewer's world
through anchor elements' renderer bounds (`solveAxisMap`), so the path does
not depend on the viewer's axis convention or origin shift. The HUD shows
label, elements, scene triangles, live frame time, fps, draw calls,
triangles per frame, and memory (tab PSS, GPU process, VRAM, JS heap); it
says SHOWCASE and "diagnostic timings, not evidence".

Outputs: `OUT/clips/LABEL-showcase-TIER.{webm,mp4,json}` (the JSON holds the
timeline, per-shot frame statistics, pick result, calibration, peaks),
`OUT/stills/LABEL-showcase-TIER-SHOT.png` (one per shot plus summary/verdict),
and the index `OUT/LABEL.json`, merged across runs, so tiers recorded in
separate GPU slices accumulate. A tier near the failure point can take most of
a 15-minute slice: record one tier per slice there.

On the PC GPU (Windows Chrome over CDP): build the viewer
in an ordinary PC job, then record inside `ifc-fleet run --gpu --host pc-wsl
--strict-host` with `--emit-stdout`, which prints every output as `HGFILE`
lines; `node scripts/perf/huge-geometry-unpack.mjs LOG OUT_DIR` rebuilds them
on Pop. The fleet refuses a job log over 256 MB, so record one or two tiers per
job (a 1M clip is about 110 MB of webm, about 145 MB as base64), or leave
`--emit-stdout` off and fetch `OUT` with a second small job. Headless Windows
Chrome paces rAF at 30 Hz (33 ms floor) and its process memory is not visible
from WSL (the HUD says so and shows the JS heap). Before any Pop GPU slice, gate
on a short known-good load and stop if it fails (CAMPAIGN.md update (c)).

Side by side (no GPU needed; Playwright's ffmpeg has no stacking filters, so
composing seeks both clips in a headless page and screenshots it):

```bash
node scripts/perf/huge-geometry-compose.mjs --out $H/video/before-after-1M.webm \
  --title 'LANE: showcase 1M' --before-label 'main' --after-label 'LANE' \
  --pair $H/base/clips/base-showcase-1M.json,$H/video/clips/LANE-showcase-1M.json
# a reel of clips one after another: --clip a.json --clip b.json
```

Loads play side by side from their own start (the faster holds its last frame
with a "loaded N s" badge), then the paths play shot by shot in lock-step with
each shot's numbers under its pane, then a verdict card with the headline
numbers (load, frame median and p95, draws, peak tab memory, VRAM).
