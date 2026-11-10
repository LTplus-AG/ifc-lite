# Modelling parity: UI probes and exercise runs (#9296, lane L4)

These scripts measure what a modeller experiences in the real viewer on a real
GPU. Every probe starts from "Start blank" and does its task with real input:

- tool shortcuts (W, Shift+S, Shift+D …) and the Drawing panel's tools and
  Export menu;
- clicks on the canvas at world points;
- typed lengths and angles in the drawing HUD;
- named controls such as the storey chip, the storey manager, the Defaults
  panel and File > Export.

The oracle is the result, never "no error". In most probes that's the IFC the
viewer exports, parsed by `lib/step.mjs`. The roof probe meshes its exported IFC with the shipped WASM kernel and uses
the SDK roof oracle to check its sloped surface, low eaves, high centre and
volume. IFC labels cannot certify the shape. The rest read the viewer's state:
the plan shapes and the section drawing.

| file | role |
|---|---|
| `run.mjs` | entry point: serves a built `dist/`, connects to Chrome on the GPU, runs probes, exercises and council frames |
| `probes.mjs` | one probe per capability where the UI is the point (ids in the contract's capability list) |
| `exercises.mjs` | F1 (a room) and F2 (the KIT FZK-Haus) modelled end to end, with council checkpoints |
| `lib/driver.mjs` | preview server, session, action counter, camera pinning, task timing |
| `lib/model-ui.mjs` | Model workspace moves: tool shortcuts, typed fields, storey chip and manager, export |
| `lib/step.mjs` | a small STEP reader for the oracles: counts, storeys, containment, quantities, wall axes, placements |
| `COUNCIL-MODELLING.md` | the council addendum for modelling frames (extends `tests/ui-scenes/COUNCIL.md`) |
| `baseline/r0.json` | round 0 results on `main` |

## Run

Build the viewer, then point the run at a Chrome with a hardware WebGPU
adapter through `--cdp <url>` or `IFC_GPU_CDP_URL`. A GPU-check helper that
starts Chrome on the machine's GPU and exports that variable is the usual way.
In WSL that means Windows Chrome, because WSL's bundled Chromium only has a
software adapter, as `tests/ui-scenes/capture.mjs` notes. The run refuses a
software adapter: an empty model canvas would read as a UI failure.

```sh
pnpm install --frozen-lockfile && pnpm build:wasm:fetch
NODE_OPTIONS=--max-old-space-size=8192 pnpm turbo build --filter=@ifc-lite/viewer --concurrency=2
cp -r apps/viewer/dist ../dist-candidate   # later builds overwrite apps/viewer/dist
IFC_GPU_CDP_URL=http://127.0.0.1:<port> node tests/modelling-parity/ui/run.mjs --dist ../dist-candidate
```

Options:

- `--only ui.storeys,ui.roof` runs only those probes.
- `--exercises F1` runs only F1; `--exercises ''` runs none.
- `--no-probes` skips the probes; `--no-frames` skips the council frames.
- `--themes light` captures one theme only.
- `--out <dir>` sets the output directory.
- `--baseline <file>` also writes the combined result file to commit.
- `--round 1` stamps the baseline round (default 0).

Output goes to `$PARITY_OUT`, or `tests/modelling-parity/.out/ui/` if that is
unset. Nothing there is committed.

- `probes.json` and `exercises.json` hold results in the contract format
  (`ifclite-parity-result/1`, with `probe: "ui"` or `"exercise"`).
- `shots/` holds screenshots.
- `artifacts/<capability-id>/` (or `artifacts/F1/`, `artifacts/F2/` for the
  exercises) holds the files the UI produced: the exported IFC, the section
  drawing as SVG, DXF and PDF, the sheet PDF, and the dimensioned SVG. Each
  result lists them in `evidence` and in `artifacts`
  (`{"ifc", "svg", "pdf", "dxf"}`, only the keys that exist). Lane L1's output
  probes validate them.
- `frames/` holds the council checkpoints with a `manifest.json` in the
  `tests/ui-scenes/capture.mjs` format.

A full run (25 probes, F1 and F2 in both themes) takes about seven minutes on one GPU.

## How actions and time are counted

- Each click and each key press is one action.
- A chord such as Ctrl+Shift+V is one action.
- A click with Alt held ("ignore snaps and surfaces") is one action.
- A press-drag-release (a 2D distance) is one action.
- Typed text counts one action per character.

`metrics.ms` is the wall time of the counted tasks, including the viewer's
response. In probes, a task marked `setup` builds the state the capability
needs, such as walls for a door. Its actions are reported as `setupActions`
and kept out of `actions`. Exercises count everything, from "Start blank" to
the download.

The harness's own work is never counted:

- setting the camera;
- reading the store;
- the oracle's own export.

When the viewer moves the camera by itself (it reframes after the first commit),
the harness restores the pinned view before the next click and counts the jump
as `cameraJumps`. A product step done through the store because the UI could
not do it would be listed under `scripted` and can never pass. Round 0 needs
none.

## Council frames

Each exercise runs once per theme. The checkpoints use the same steps, the
same camera and the same 1600x900 viewport. Pair a candidate against the
baseline like this:

```sh
node tests/ui-scenes/pair.mjs --a <candidate-out>/frames --b <baseline-out>/frames --out <packet> --key <key.json>
cp tests/modelling-parity/ui/COUNCIL-MODELLING.md <packet>/
```

Frames are not committed (#9054: evidence lives in the PR, not the tree).
`baseline/r0.json` records each frame's sha256 and layout metrics.

## Round 1 coverage (U4)

Every table-stakes row now has a UI probe. Unsupported requirements and
requirements without an oracle remain explicit failed checks, so a narrow
success cannot award the whole row. The grid result also has its own capability
id; the original grid/column result only credited structure.

The session-scale probe uses 20 walls and checks a height edit and Undo through
exported IFC. Under `ifc-gpu-check`, its task durations are diagnostic only.
It cannot pass the large-model timing requirement: qualify that separately with
exclusive benchmark admission on Pop. PC benchmarks are disabled.

Use a fresh output directory per cohort when scoring: the scorer keeps the best
result per level, so mixing old and new runs can conceal a regression. Pass the
SDK result directory and UI directory explicitly to the output runner and scorer.
