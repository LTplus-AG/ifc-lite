<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Gaussian splat reuse spike

Research example for [Discussion #8141](https://github.com/LTplus-AG/ifc-lite/discussions/8141).
It does not enable splats in the production viewer or CLI. It compares published
upstream engines without implementing a Gaussian decoder, rasterizer or sorter.

## Continuation: explicit depth convention (2026-11-01)

The original experiment below is preserved. The continuation proposes a narrow
upstream `SplatRenderer.depthConvention` option (`standard` by default, or
`reverse`), independent of the opaque depth comparison. Reverse projected depth
is negated before the existing upstream sorter runs. Changing the option
invalidates cached ordering. No decoder or sorter is forked into the viewer.

The [upstream patch](./upstream-depth-convention.patch) targets luma commit
`e3979f06848a6d04547ac7a26f844212ba569806`, after its move to `engine/splats`.
It includes TypeScript API declarations, regression tests and documentation.
`git apply --check` passed against that pinned source and documentation. The
original patch is preserved as historical evidence. The subsequently validated revision
`71e2be2394ecd9bdfb6f1d36ce23e6af92978015` is submitted as
[luma.gl #3619](https://github.com/visgl/luma.gl/pull/3619). Its 13 CI checks pass,
including browser coverage and website builds. Local build/lint, 4,799 node tests
and focused GPU readbacks pass; nine node tests and one existing attachment case
were skipped. The full local headless endurance run was interrupted, not passed.

Runtime qualification uses published `@luma.gl/splats@9.4.2`: the witness applies
the same three implementation changes in memory through a Vite load hook,
after checking the original renderer's SHA-256. Installed package files remain
unchanged. This is an experimental backport, not a claim that current master or
its GPU paged renderer has been qualified. The existing mixed-scene example
still uses unchanged upstream rendering and retains its original failure.

After root `pnpm install`, run the bounded witness through fleet admission in
the prepared checkout (the command needs Chrome at Playwright's `chrome` channel):

```sh
~/build-workers/ifc-fleet run --route local --cwd "$PWD" \
  --storage-task gaussian-depth-witness --cpu 2 --memory 4 -- \
  ~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/validate-depth.mjs
```

This repository workflow explicitly uses Playwright and SwiftShader for direct
texture readback. The GPU wrapper serializes it against other GPU work; the
witness intentionally uses its own software browser, not the wrapper's hardware
CDP endpoint. It requires no model downloads. Output is `depth-result.json` under
`SPLAT_SPIKE_EVIDENCE` (default `/tmp/ifc-splat-8140-depth`); use distinct output
directories when preserving multiple manual runs. Close the owning storage task
after its receipts are finalized and compact evidence is published.

[Recorded evidence](./depth-results.json): all 28 asserted cases passed, with
no browser/WebGPU errors. Original perspective reverse-Z produced
`[50, 0, 189, 255]`; the patch produced `[191, 0, 48, 255]`. Orthographic reverse-Z
also changed from blue-dominant to red-dominant. Tests exercise constructor
configuration, convention-only changes without changing the camera, standard
and reverse projections, opaque shared-depth occlusion, and source-order mode.
Negative controls intentionally remain blue-dominant. This is SwiftShader
correctness evidence, not real-hardware performance evidence.

Remaining blockers are unchanged: the CPU path approximates densely interleaved
draw runs, the GPU paged renderer still hardcodes conventional depth comparison,
and exact transparent IFC/splat composition is unqualified. Clipping, picking,
MSAA, lifecycle failure handling and full production loader integration remain
outside this continuation. Upstream maintainer review/merge and the native viewer
contract tracked in #8564 remain outstanding; upstream CI does not qualify
production integration.

## Reproduce

Use the root pinned pnpm toolchain. Install dependencies normally, then prepare
optional fixtures (about 16 MB of captures plus the existing FZK model and the
published IFC-Lite WASM runtime):

```sh
node examples/gaussian-splat-spike/prepare.mjs
```

Fixtures stay in `~/.cache/ifc-lite/gaussian-splat-spike`, outside Git. Pass an
absolute directory as the first argument to change that location, and set
`SPLAT_SPIKE_ASSETS` to the same directory for subsequent commands.

On a managed host, launch the example through fleet admission:

```sh
~/build-workers/ifc-fleet run --cwd "$PWD" --kind service \
  --storage-task gaussian-spike-interactive --cpu 2 --memory 4 -- \
  pnpm --filter ifc-lite-gaussian-splat-spike dev
```

Open the printed loopback URL. Switch between PlayCanvas and luma.gl with the
links. Toggle assets, change the camera, then release the scene. A private E57
can be selected through the local file input; its bytes are never uploaded.

For an already aligned IFC/E57 pair, set `SPLAT_SPIKE_IFC` to the absolute IFC
path when launching the server. The file input still supplies E57 locally.
The host serves only that explicitly registered IFC path, rather than exposing
an arbitrary path endpoint. The E57 preview receives the same IFC RTC origin
subtraction and IFC Z-up to viewer Y-up conversion; it is not independently
centered or scaled. Public splats remain artificially positioned, non-metric
objects and establish no survey registration.

The automated functional witness uses Chrome/SwiftShader, one backend at a
time. It selects `SPLAT_SPIKE_E57` only when explicitly set, saves local
screenshots and compact JSON to `SPLAT_SPIKE_EVIDENCE` (default
`/tmp/ifc-splat-8140-evidence`), and closes both server and browser. Keep private
screenshots outside a public PR. Launch it under the same admission policy:

```sh
~/build-workers/ifc-fleet run --cwd "$PWD" --kind service \
  --storage-task gaussian-spike-witness --cpu 2 --memory 4 -- \
  node examples/gaussian-splat-spike/validate.mjs
```

The separate package tests run through root Turbo:

```sh
pnpm test --filter=ifc-lite-gaussian-splat-spike
```

Tests skip real captures with a preparation hint when absent. `typecheck` in
this JavaScript experiment is syntax validation, not TypeScript coverage. The
root `pnpm typecheck` script does not forward trailing filter arguments to its
Turbo invocation; do not use a trailing filter expecting a bounded run.

## Data and provenance

Two real photographic captures from
[Marcel Padilla's collection](https://github.com/marcelpadilla/splats), pinned to
commit `c3e5ec0a8ddb3ab26f28a067a29d272fe1a23411`:

- **Houseplant:** 113,648 Gaussians, 3,636,736 bytes;
  SHA-256 `ce9d490b18f16d6730d832227bf541431b8b1a5d167c5a3fe89af4f324c0d8fd`.
- **Textile ball:** 384,589 Gaussians, 12,306,848 bytes;
  SHA-256 `30a84f6fd18e1e027ff0bb639353fa6301dc4c6a2da7cdda157b51ed58a5de05`.

Both are CC-BY-4.0; credit **Marcel Padilla**, link to the collection and license,
and identify the artificial placements when sharing renders. `prepare.mjs`
saves the per-object metadata and complete upstream license alongside the
files. These captures have SH degree 0 and non-metric reconstruction scale.
They cannot qualify higher-order SH, georeferencing, LOD or SPZ support.
Generated and mesh-derived entries in the wider collection have different
terms and were not selected.

The default IFC is `ara3d/AC20-FZK-Haus.ifc`, fetched by the repository fixture
manifest's size and hash. No local similarly named copy is trusted without
matching that manifest. The WASM runtime is published `@ifc-lite/wasm@10.6.1`,
not a build from this branch; preparation records its package hash.

Locally supplied models, scans, screenshots and derived scene metrics are
excluded from the published fixture catalogue and results. Optional local-file
inputs are available for users to run their own validation.

## Integration boundary

- **SplatTransform 3.10.3:** actual `.splat` parsing through its file-system and
  chunk-source APIs. PlayCanvas's Gaussian iterator interprets encoded scale,
  rotation, opacity and DC colour. The experiment's code only adapts columns
  and applies explicit placements.
- **PlayCanvas 2.23.3:** complete upstream scene renderer, native WebGPU, IFC
  geometry uploaded as double-sided meshes and E57 positions as point
  primitives. This evaluates adopting its scene runtime; it does not show its
  Gaussian subsystem running inside IFC-Lite's existing renderer.
- **luma.gl splats/webgpu 9.4.2:** unchanged published splat renderer, native
  WebGPU device, IFC-Lite's existing `PointCloudRenderer` and a minimal unlit
  host mesh pass fed by real IFC geometry. The host pass is an experiment, not
  production IFC appearance, picking, federation or clipping integration.

The current production viewer still requires its single canonical
`useIfcLoader.loadFile(file, target)` path. A successful standalone scene does
not authorize adding an alternate production loading path. Likewise the CLI's
embedded viewer needs an explicit shared-runtime integration later.

## Findings to preserve

The npm registry publishes `@luma.gl/splats@9.4.2` even though the current
master documentation describes an unpublished module. The registry artifact,
not that documentation, is the version evaluated here.

Unchanged luma `SplatRenderer` has a configurable depth comparison, but its CPU
visibility path sorts conventional projected depth descending. The invariant
test demonstrates that comparison direction alone is insufficient for
reverse-Z alpha ordering. More than 64 interleaved draw runs also trigger its
bounded depth-slab approximation. The published GPU paged renderer hardcodes
`less-equal` and owns its presentation pass; master-only host-pass methods are
not assumed to exist in the published version.

The first native mixed-pass attempt failed WebGPU validation: the Gaussian
shader does not output IFC-Lite's object-ID colour attachment, and luma's pass
builder omits stencil load/store operations for the depth/stencil format.
The experiment therefore tests a second, colour-only splat pass retaining the
same depth texture, with stencil read-only. This does not solve reverse-Z
sorting, object picking or transparent IFC/glass compositing.

No frame-rate, memory-budget or production-readiness claim follows from a
SwiftShader functional witness. Required follow-up acceptance includes real
hardware, MSAA, perspective and orthographic views, higher-order SH, exact
cross-asset alpha ordering, clipping, cancellation and device-loss recovery.

## Measured outcome (2026-10-25)

[Public evidence](./results-summary.json) records pinned runtime source-file
hashes, public capture counts and the synthetic ordering probe. The public
fixture tests decode all 498,237 Gaussians through upstream code and check finite
positions, positive scales, valid opacity and quaternion norms. Locally supplied
IFC/scan results and their scene metrics or images are excluded.

The recorded `baseCommit` is the original worker's **pre-edit HEAD**, not a
checkout that contains the measured example. The original successful receipt
`b922c7d9-578f-4fc8-8031-364e7400ded0` records a dirty working tree; its recovered
output confirms the public counts and `[50, 0, 189, 255]` probe. All 12 recorded
runtime files **and the lockfile** match the later committed snapshot
`dd6a54799ec1853714076942b19db3b1bb82643e` byte-for-byte. Use that revision to
recover those source bytes. This is a file-level provenance match, not a new
run or a claim that the worker certified an unchanged full repository (it did
not). Later research revisions and #8557 changed these files; `point-resources.mjs`
is a later addition, outside this historical inventory. The original hashes
remain unchanged. Private inputs and full-scene results remain excluded.

Direct GPU texture readback is used by the browser witness: compositor
screenshots of the presentation canvas can return blank pixels despite
successful draws. Run the optional witness with your own inputs to inspect mixed
scenes; these fixture tests do not qualify full-scene rendering or performance.

**Native luma adoption is blocked by a demonstrated alpha-order defect.** A
64-pixel reverse-Z witness puts a red Gaussian in front of a blue one, both at
opacity 0.75. The centre reads `[50, 0, 189, 255]`: blue dominates, violating the
near-red-over-far-blue invariant. This is a rendered counterexample, in addition
to the CPU sort invariant. A successful mixed-scene screenshot is therefore
not a correctness qualification. The native host uses a separate colour-only
splat pass over the shared depth buffer to avoid the attachment/stencil errors.

**Decision:** retain the existing production viewer. Reuse SplatTransform's
format pipeline, keep PlayCanvas as the working reference, and pursue upstream
luma fixes before adopting a native adapter. Do not replace IFC-Lite's scene
runtime solely to obtain splats, or fork a Gaussian sorter/rasterizer into this
repository. A later production issue needs a reverse-Z-aware ordering contract,
GPU path integration, exact cross-asset alpha qualification, clipping and
real-hardware performance evidence. The example's CLI entry point launches the
research scene; the production `ifc-lite view` command remains unchanged.

The focused root test run passed three tests, with both optional captures
present. An attempted filtered root typecheck expanded to the full workspace
because its shell script does not forward filters to Turbo; it was stopped
and its unrelated tail failed. It is not recorded as a full typecheck pass.
The experiment itself is JavaScript, and its syntax and Vite build are checked.

The behavioral oracle manifest uses `issue: 7955` because
`scripts/revert-oracle-discover.mjs` requires that framework identifier. Its
directory, witness name and rationale identify the actual regression as #8140.
