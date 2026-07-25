# Moonshot demo-video render pipelines

Two headless render pipelines that produce clean 1920x1080 demo footage from
real IFC geometry, meshed by the workspace's own wasm kernel and rendered by
the workspace's own three.js build in real Chrome (Playwright). No CDNs, no
overlays; each pipeline writes a `frames-metadata.json` so post-production can
drive counters and captions from real data.

## Pipelines

- `pipeline-morph.mjs` - "gradient descent designs a building". Re-runs the
  certified diff-spike optimizer (`scripts/moonshot/diff-spike`), materializes
  parameter snapshots as real IFC via `buildIfc`, meshes each with the wasm
  `GeometryProcessor`, and renders one frame per snapshot with a slow orbit.
- `pipeline-grid.mjs` - "we built a million buildings". Generates N seeded
  world-gym buildings (`tools/world-gym`), lays them out on a square grid, and
  renders a receding shot from one hero building to the full grid, buildings
  materializing in seeded waves.

## Prerequisites

Run from the repo root with workspace artifacts staged:

```sh
pnpm install
# wasm pkg (packages/wasm/pkg/ifc-lite_bg.wasm) - build once, or copy from a
# checkout that has it:
node scripts/run-build-wasm.mjs
pnpm --filter @ifc-lite/data --filter @ifc-lite/geometry build
```

Rendering drives real Chrome via Playwright (`channel: 'chrome'`), so Google
Chrome must be installed. `ffmpeg` is optional: when present the pipelines
assemble an mp4 and use it for jpg samples; when absent they write an
`ffmpeg-command.txt` next to the frames (and fall back to macOS `sips` for
samples). Nothing is ever installed by these scripts.

## Usage

```sh
node scripts/moonshot/video/pipeline-morph.mjs [--out=DIR] [--snapshots=200] \
  [--fps=30] [--headed] [--no-video]

node scripts/moonshot/video/pipeline-grid.mjs [--out=DIR] [--count=576] \
  [--frames=240] [--fps=30] [--headed] [--no-video]
```

Arguments use `--key=value` form only (`--snapshots=24`). Space-separated
`--key value` is not parsed and will crash or be ignored.

## Output convention

Outputs default to `$VIDEO_OUT_DIR/<pipeline>` when `VIDEO_OUT_DIR` is set,
otherwise `<os tmpdir>/ifc-lite-video/<pipeline>`; agents should point
`VIDEO_OUT_DIR` (or `--out=`) at their session scratchpad. Per pipeline:

- `scenes/*.bin` - merged per-snapshot / per-building geometry
- `frames/frame_XXXXX.png` - rendered frames
- `frames-metadata.json` - per-frame data (carbon, step, constraints, visible
  count, camera) for post
- `<pipeline>.mp4` - when ffmpeg is available

Each run also refreshes `samples/` (commit-sized jpg proof frames) next to
these scripts. `VIDEO_DEBUG=1` logs render-host HTTP requests.

## Known refinements

- world-gym's office family renders open-topped from high camera angles (no
  roof slab is authored); prefer low-elevation shots or the frame family for
  hero framing.
- world-gym's frame family authors its roof slab with an absolute elevation in
  a storey-local Position; `pipeline-grid.mjs` corrects the double-applied
  storey offset locally (tools/world-gym is read-only for these pipelines).
