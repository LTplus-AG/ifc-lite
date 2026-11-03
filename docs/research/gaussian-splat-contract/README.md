# Native splat rendering contract: first counterexample

Tracking: [#8564](https://github.com/LTplus-AG/ifc-lite/issues/8564), part of [#8562](https://github.com/LTplus-AG/ifc-lite/issues/8562). Launch formats remain Gaussian PLY and `.splat`.

**Public enablement remains blocked.** This witness demonstrates that `SplatRenderer.drawMixed` cannot correctly compose transparent geometry between splats. It does not qualify the production viewer or complete the remaining rendering contract.

This directory contains an external luma browser-harness reproducer and static
research results. IFC-Lite does not import these files, and its root test command
does not execute the patch. They live under `docs/research` to distinguish that
evidence from runnable example code; the existing changed-tests oracle excludes
documentation. No oracle classification rule or acceptance requirement is changed.
The earlier [spike results](https://github.com/LTplus-AG/ifc-lite/blob/dd6a54799ec1853714076942b19db3b1bb82643e/examples/gaussian-splat-spike/results-summary.json) likewise record a
historical measurement, not a runtime configuration.

## Measured behavior

On upstream luma commit `700f1400fc6b0d32a82f1a22f57c1e747b255a01` with the depth-convention fix, render a near red Gaussian, a 50%-transparent green triangle at the intermediate depth, and a far blue Gaussian. The independent reference submits far splat, green triangle, near splat. The helper submits both sorted splats before the transparent triangle.

Center RGBA readback is `[189,33,24,255]` for the reference and `[94,128,24,255]` for `drawMixed`. The green triangle incorrectly covers the near red splat. The diagnostic test passes by asserting this counterexample; **exact composition fails**. Weighted transparency or sorting whole assets does not resolve this requirement.

Destroying the attached luma wrapper, then submitting a buffer clear through the original raw GPU device, succeeds without validation errors. This verifies borrowed-device survival for this isolated case.

The run used Chromium WebGPU with SwiftShader, not hardware performance qualification. The combined run passed 14 tests and skipped one existing configured-canvas reattachment test. The two depth readback tests and this diagnostic did not skip. Compact results and the original worker receipt ID are in `results.json`.

## Cleanup revision (PR #8570)

The original 14-pass/1-skip measurement above is retained unchanged. The revised
patch encloses attachment, rendering assertions and the borrowed-device probe
in an outer `finally`, conditionally destroys the witness buffer, and destroys
the raw device even if buffer cleanup throws. Wrapper teardown still precedes
the borrowed-device survival probe.

A fresh admitted Chromium/SwiftShader run on upstream depth-fix commit
`71e2be2394ecd9bdfb6f1d36ce23e6af92978015` passed **18 tests**, with the same one
configured-canvas skip. It reproduced both original pixel arrays and borrowed
device survival. Four added fault cases cover a pre-attach assertion, rejected
attachment, composition assertion, and ownership assertion after buffer creation.
Spies on real WebGPU methods verify exactly one raw-device destruction in every
case and exactly one witness-buffer destruction when allocated. These are failure
cleanup checks, not hardware or production-lifecycle qualification.

`results.json` separates the original measurement from this revised reproducer,
including both patch hashes and the new build/browser receipts. The pinned
Node 22.23.4 / Yarn 4.13.0 install and upstream build passed in an isolated source
export; the shared upstream checkout was left untouched. One earlier browser
submission never started because storage registration failed during build receipt
publication; its original receipt is retained separately from the successful run.

## Reproduce

Use upstream depth-fix commit `71e2be2394ecd9bdfb6f1d36ce23e6af92978015` from `louistrue/luma.gl` (base `700f1400fc6b0d32a82f1a22f57c1e747b255a01`). Apply `mixed-transparency.patch` there, install using its pinned Node/Yarn versions, build, then run its documented browser harness:

```sh
CI=1 corepack yarn test-headless --maxWorkers=2 --reporter=verbose \
  modules/engine/test/splats/ifc-mixed-transparency.spec.ts \
  modules/engine/test/splats/splat-depth-convention.spec.ts \
  modules/core/test/webgpu/adapter/webgpu-adapter-attach.spec.ts
```

This is the complete three-file selection recorded by successful receipt
`c7670da1-8e1a-4503-9cfd-6cc195dd0063` for the revised **18-pass/1-skip** run.
The first file alone runs only the five mixed-transparency diagnostics.

On the managed development fleet, execute through fleet admission and `ifc-gpu-check`. The patch is an external-harness diagnostic, not a test included by IFC-Lite's root test command.

## Remaining contract

A shared composition approach must preserve the rendered order of IFC glass/X-ray and Gaussian contributions; it needs adversarial intersection references before integration. Continue to reuse upstream Gaussian rendering. Do not enable a second standalone canvas as a production substitute.

Still unqualified: actual viewer-owned device/frame submission, stencil and MSAA, resize/device loss, more than 64 interleaved source runs, global ordering across two public licensed captures, real IFC plus point cloud, clipping/object-ID behavior, hardware resource budgets, and the full load/unload lifecycle. The borrowed-device result above does not establish these properties. The graph/paged renderer does not receive reverse-Z support from the depth patch.

## Bounded native-frame prototype (continuation)

**Architectural verdict: frame sharing is feasible in the restricted witness;
exact IFC transparency composition is still blocked. #8564 remains partial.**
No production feature flag, loader, viewer UI, standalone production canvas or
Gaussian rasterizer is added. The [HTML entry](https://github.com/LTplus-AG/ifc-lite/blob/ec8a0c3ac14393f5d09638a80c8b912c3f4cf2a7/examples/gaussian-splat-spike/contract/native-witness.html) is a manual offscreen diagnostic.
Runnable harness files remain under `examples/gaussian-splat-spike/contract`;
this directory holds their documentation and static results. The earlier spike
[provenance note](../gaussian-splat-spike-provenance.json) describes a separate
historical run; its hashes and this continuation's recorded hashes are unchanged.

[`native-results.json`](./native-results.json) records source commit and worker receipt. The 32 image
comparisons use two synthetic overlapping sources (96 rows), reverse-Z camera
math imported from IFC-Lite, perspective and orthographic projections, distinct
close depths and exact ties, 64→80 target recreation, and 1×/4× MSAA with
`rgba8unorm` + `depth24plus-stencil8`. The application owns the raw encoder,
render pass, attachments and queue submission; luma wraps those existing handles.
There were no browser or WebGPU errors. Destroying the wrapper leaves the borrowed
raw device usable. This is SwiftShader correctness, not hardware qualification.

The reference packs the identical rows into one source, preserving source order
for equal-depth ties, and uses the same upstream renderer. It cannot take the
multi-source slab fallback. Unmodified run partitioning changes pixels in all 16
cases; the bounded exact prototype matches the entire reference image in all 16.
For the 64-pixel perspective case, the center is `[113,0,142,255]` with slabs and
`[121,0,132,255]` with exact runs/reference. This establishes the partitioning
invariant, not independent validation of upstream Gaussian math. The prototype
rejects a 130-run input before submission rather than approximating it.

### Precisely what was patched

Runtime uses **published 9.4.2 with explicit in-memory patches**, not an assertion
that upstream PR #3619 contains these additional changes. [`exact-runs-plugin.mjs`](https://github.com/LTplus-AG/ifc-lite/blob/ec8a0c3ac14393f5d09638a80c8b912c3f4cf2a7/examples/gaussian-splat-spike/contract/exact-runs-plugin.mjs)
checks SHA-256 of the original renderer and WebGPU device before transformation.
Installed packages and the shared upstream checkout remain unchanged.

- Both modes apply the existing reverse-Z proposal.
- Published `attach()` throws; the witness uses the published `WebGPUDevice`
  constructor and a restricted ownership guard in `destroy()`. Current upstream
  already implements borrowed attachment; this small offscreen backport is not
  its full attachment, listener cleanup, device-loss or canvas lifecycle contract.
- Both modes propagate attachment sample count into the upstream model's existing
  pipeline parameters. Its attachment-format synchronization alone does not do
  this. This is an additional upstream integration requirement.
- Exact mode changes the source-run budget from 64 to 128 and throws on overflow;
  all sorting, source buffers, shader evaluation and rasterization remain upstream.
  The existing source-run loop emits 96 draws instead of 64. This deliberately
  bounded research mode is not a scalable production solution. Renderer-reported
  GPU bytes exclude attachments, pipeline/driver allocation and CPU overhead;
  they cannot establish the production resource budget.

### Glass crossing reference and blocker

[`intersection-witness.mjs`](https://github.com/LTplus-AG/ifc-lite/blob/ec8a0c3ac14393f5d09638a80c8b912c3f4cf2a7/examples/gaussian-splat-spike/contract/intersection-witness.mjs) renders a green 50% glass triangle whose depth crosses
a red Gaussian's constant projected depth at the vertical screen midpoint. On
the left, glass is behind the Gaussian; on the right, glass is in front. A
scissored reference submits the independently known far-to-near order on each
half. The scissor is a reference for this constructed scene, not an implementation
for arbitrary glass. Sample positions are away from the equal-depth boundary.

The reference's left/right samples are `[171,42,0,255]` / `[83,128,0,255]`.
Glass-first incorrectly yields `[166,45,0,255]` on the right. Splats-first
incorrectly yields `[86,128,0,255]` on the left. Each whole-object order differs
from the reference in 4,096 channels. These are asserted diagnostic failures,
not a passing general composition gate. More accurate source sorting or exposing
per-run draws cannot fix even this one-Gaussian, one-triangle crossing.

The required reference contract is per-sample far-to-near alpha-over after opaque
occlusion and clipping, with a declared deterministic tie rule shared by IFC and
splats. Arbitrary intersections require per-sample depth partitioning (for example
exact depth peeling or bounded fragment collection followed by a common resolve),
or equivalent geometry splitting. Upstream needs a reusable participation hook
for its Gaussian contributions; IFC needs the matching geometry participation.
A collection/peeling budget must reject or report exhaustion, never silently
switch to weighted transparency. No such general compositor is implemented or
qualified here. Replacing the Gaussian rasterizer is neither needed nor proposed.

### Actual viewer integration points inspected

At the recorded parent commit, `packages/renderer/src/index.ts` obtains the device
from `this.device.getDevice()`, creates the encoder inside `renderFrame`, and
submits through `renderer-frame-timing.ts:submitRendererGpuTiming`. That function
also submits opaque-visibility command buffers; a splat adapter must not call
its own `device.submit()` between those commands. Predraw/upload work belongs
before the pass opens; Gaussian draw work must use the existing pass.

`pipeline.ts` defaults to 4× MSAA and `depth24plus-stencil8`, with a second color
attachment for object IDs. `camera-matrices.ts` derives perspective/orthographic
reverse-Z matrices; the production point-cloud call consumes the relative-to-eye
frame and section/crop state. Splat positions must use that same coordinate frame,
not just the absolute view-projection matrix used by this small origin-centered
witness. The individual-mesh transparent path currently sorts by express ID
(`index.ts`), and the point-cloud draw occurs after the transparent mesh paths.
Neither is a valid exact compositor insertion point without restructuring.

Still **unqualified**: actual viewer renderFrame execution; BGRA/presentation and
object-ID MRT behavior; stencil masking (attachment compatibility alone passed);
IFC glass/X-ray material semantics beyond the constructed alpha-over plane;
real IFC + point cloud + two licensed captures; crop/section planes; selection and
picking; translated/RTE scenes; device-loss/recovery and repeated load/unload;
hardware memory/frame budgets; global tie semantics across arbitrary asset IDs;
and scalable exact order beyond this bounded CPU run path. The paged/GPU renderer
is not exercised. These remain blockers, not waived acceptance bullets.

### Reproduce this continuation

After root `pnpm install`, use the admitted manual workflow below. It uses the
repository's documented Playwright/SwiftShader harness; no fixture downloads.
Both the known-failing baseline and exact prototype must satisfy the diagnostic
assertions. `native-result.json` is written under `SPLAT_SPIKE_EVIDENCE` (default
`/tmp/ifc-splat-8564-native`). Root Turbo syntax checks include `contract/*.mjs`;
the browser witness is manual and is not run by `pnpm test`.

```sh
~/build-workers/ifc-fleet run --cpu 2 --memory 4 \
  --pool gaussian-production-8562 --storage-task UNIQUE_TASK --cwd "$PWD" -- \
  bash -c '~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/contract/validate-native.mjs'
```

Preserve compact results and original receipts, then close the task on each owning
host. Early setup failures are not tests: the first Pop request lacked Vite, its
follow-up failed storage job-open, and the first local browser run exposed the
published unimplemented `attach()` API. The final recorded run completed the
assertions with no skipped cases; it does not erase those earlier outcomes.

### CPU behavioral regression coverage (#8564)

Root `pnpm test --filter=ifc-lite-gaussian-splat-spike` also executes the exact-run
plugin against the hash-pinned upstream renderer in Node. A CPU-backed subclass
of luma's `Buffer` and `Device` exercises the actual resource lifecycle without a
GPU driver. Tests verify 96/128 alternating source runs, contiguous row partitioning,
index-buffer bytes, populated-buffer preservation on 129-run rejection, reuse on
shrink, and exactly-once cleanup. Source sorting, shaders and frame submission are
not executed by these tests. The original native overflow witness still starts
empty; populated-buffer preservation is now dynamically tested at the CPU resource
boundary only, not newly GPU-qualified. Original GPU evidence is unchanged.

The ordinary changed-test oracle removes the new plugin and executes the same
tests against the published upstream renderer; ordering and overflow assertions
then fail. A separate `populated-overflow.oracle.patch` under
`tests/evidence/gaussian-8564-exact-runs/` deliberately detaches populated buffers
before throwing, so the preservation assertion must fail even though rejection
still occurs. Neither negative control changes gate classification or acceptance.

## Next native adapter boundary (#8564)

`@ifc-lite/renderer` now separates raw decode from normalized render attributes.
The converter preserves source coordinates and unclamped radiance, maps PLY
channel-major SH into upstream basis-major RGB, and rejects non-finite/degenerate
channels. Its arrays are independent CPU allocations. It does not upload, infer
placement, or claim that a model can render. `Renderer.getGaussianReadiness()`
uses the actual renderer generation and loss/disposal latches: even a healthy IFC
renderer reports Gaussian blocked. This is the canonical-loader integration seam,
not a second canvas or a production enablement switch.

The feasible composition candidate is native transparent depth peeling plus
upstream globally sorted splat draws filtered to the per-pixel intervals between
peeled layers. With reverse-Z, intervals are lower-exclusive/upper-inclusive; the
chosen tie order places a splat at the glass depth behind that glass contribution.
A complete compositor also needs deterministic ordering of coincident native
transparent fragments. Every fragment must occur exactly once. Peeling exhaustion
must reject the frame, not present a truncated success.

`contract/fragment-interval-plugin.mjs` proposes only a sampled interval and
fragment discard in the hash-pinned upstream shader. Covariance projection,
Gaussian alpha, sort and blending remain upstream. The separate native witness
rasterizes a sloping glass triangle into two interval textures, then submits far
splats, glass, near splats on the borrowed native encoder/pass. Its independent
reference computes the known triangle depth at each pixel center and submits the
corresponding order with pixel scissors. Removing the discard is the negative
control. This is a **one-layer mechanism experiment**, not a multi-layer compositor
or a production renderer. The original counterexample artifacts remain unchanged.

Outstanding upstream work: scalable exact global GPU ordering with no source-run
approximation; native/paged reverse-Z parity; an explicit depth-interval API with
per-sample MSAA semantics; clipping and ID output; and borrowed attachment/resource
ownership across resize and device loss. IFC-Lite still needs native transparent
peeling integrated into `renderFrame`, RTE/placement/SH rotation, real-model
interaction, overflow reporting, hardware resource budgets and production smoke
evidence. The one-layer experiment cannot waive any of these release blockers.

The historical run at `1f957a0a5d` and its original
`fragment-interval-results.json` remain unchanged. Review #8616 found that its
nonblank check counted green glass and its reference shared the interval filter.
Those results therefore do not establish independent splat contribution.

The revised witness serves the reference separately using `exactRunsPlugin` only:
the upstream fragment shader has no interval binding, texture read or discard
extension. Pixel scissors still select the independently computed glass order.
Both reference and candidate must contain red pixels (only splats write red in
this scene), and their complete images must match exactly. The discard-removal
control must differ while retaining splats. The all-splat-discard control must
have zero red pixels and fail the same positive acceptance predicate. A CPU
regression also rejects identical green-only images even with zero differences.
New GPU evidence is recorded separately in `fragment-interval-oracle-results.json`.
Production qualification remains blocked.

Reproduce from the repository with installed dependencies and Playwright Chromium, through
ordinary fleet admission and the GPU serialization wrapper:

```sh
~/build-workers/ifc-fleet run --route local --kind ordinary --cpu 2 --memory 4 \
  --pool gaussian-production-8562 --storage-task UNIQUE_TASK --cwd "$PWD" -- \
  bash -c '~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/contract/validate-fragment-interval.mjs'
```

This is a manual GPU witness, not part of root `pnpm test`. It does not qualify
multi-layer peeling, per-sample MSAA, viewer rendering, licensed capture scenes or
hardware performance. Public enablement remains blocked.

## Internal native adapter in the viewer frame (#8564 increment)

`Renderer.gaussianSplats` is an internal, unqualified adapter: upstream luma.gl
`SplatRenderer` draws on the renderer's own `GPUDevice` inside `renderFrame`.
Readiness stays `blocked` (now with `capabilities` beside `reasons`), and `add()`
requires `{ qualification: 'internal-unqualified' }`. The guide's "Internal
Gaussian adapter" section states the contract and its disclosed demo semantics.

What the increment settles, in the restricted scenes below:

- **Shared device and frame.** One pass after the main pass loads colour, tests the
  shared reverse-Z depth read-only and performs the MSAA resolve. luma wraps the
  viewer device without owning it; a 1x1 luma-owned framebuffer only describes
  formats. No viewer device, encoder or attachment is destroyed by the adapter.
- **Global order across assets.** Packing every asset into one upstream source
  removes the run partitioning entirely, so the published 64-run slab fallback and
  the 128-run research budget no longer apply. Upstream's own sort and draw run
  unchanged.
- **Placement.** Similarity transforms with covariance and SH band rotation; the SH
  matrices come from upstream's basis evaluator and are checked against
  f_rot(d) = f(R^T d). Reflections are rejected rather than baked unverified.
- **Lifecycle.** Identity-validated handles; loss makes assets `pending` at once;
  `recoverDevice()` re-uploads them under the same handles.

GPU witness (`contract/validate-native-adapter.mjs`, manual, through
`ifc-gpu-check`) drives the real `Renderer`. Each scene compares against an
independent reference: analytic colours, a one-asset or base-commit frame, or the
same frame without the asset. Recorded at `65b7479a9c`: SwiftShader 268/268,
NVIDIA hardware over the documented CDP endpoint 269/269, zero WebGPU errors (the
first record, at `989a3630cc`, was 213/214 checks before later scenes). Scenes:
opaque IFC and point-cloud
occlusion; two assets equal one asset equal reversed add order with 96
interleaved runs; perspective, orthographic and resize under 4x MSAA; centre
clipping; visibility, placement and removal round trips with stale handles; device
lifetime; pick pass-through; camera-dependent sort refresh; and a real loss (raw `GPUDevice.destroy()`)
recovered by `recoverDevice()` with the post-recovery frame pixel-identical to the
pre-loss frame. An IFC-only page shows base and head frames pixel-identical for
the shared per-mesh uniform helper.

```sh
~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/contract/validate-native-adapter.mjs --backend=swiftshader
~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/contract/validate-native-adapter.mjs --backend=hardware
```

Still blocked, not waived: exact per-sample composition with IFC glass and X-ray
(splats currently composite over them), per-fragment clipping and caps, picking
semantics beyond pass-through, scalable GPU ordering (the upstream CPU sort runs
per camera change), hardware resource budgets, canonical viewer ingestion and
production smoke tests.

## Nearest-glass split in the adapter (#8564, option B)

Decided on 2026-11-03 (#8564, #8562): the adapter composes splats with transparent
IFC by a single nearest-glass split, the K = 1 case of the K-layer plan above,
without its peel stack. In a frame with splats and transparent IFC:

1. the main pass holds back its transparent draws and the selection highlight
   (`gaussian-pass-recorder.ts`, recorded as issued, never re-enumerated);
2. P1 = the nearest transparent depth per sample: the held draws replay through
   depth-only variants of their own pipelines (same vertex stage and depth nudge,
   the base fragment called for its discards, no colour) into a depth32float target
   cleared to the far plane (`gaussian-glass-split.ts`);
3. splats with depth <= P1, then the held draws as recorded, then splats with depth
   > P1 and the MSAA resolve (`gaussian-glass-frame.ts`).

Both splat draws use one upstream renderer (one sort) through the patch's opt-in
depth-interval shader: one bound texture and a `greater` / `less-equal` flag, so
every sample is written exactly once. They still test opaque depth in hardware, as
the single pass does. Where no transparent IFC covers a sample P1 is the far plane,
so every splat sample lands in the second draw in the single pass's order. The
interval reaches the backend only through `GaussianBackendScene.encode(…, interval)`,
so a future GPU-sorting backend can implement the same hook.

**Exact:** every sample with at most one transparent layer in front of opaque
geometry, and splats behind or in front of every layer. **Approximate:** splats
between two transparent layers (drawn before all of them). A stencil count of
transparent surfaces in front of opaque depth with an occlusion query reports
`transparentLayers: 'multiple'`. Only zero versus non-zero is portable: Dawn on
D3D12 answers occlusion queries in binary (NVIDIA reported 1 for every positive
count). A closed glass solid has two surfaces. Every X-Ray frame reports `multiple`:
in the witness X-Ray scene (three ghosted boxes) SwiftShader, which counts samples,
put 94.5 % of the ghosted samples beyond exact. The policy for X-Ray is open for the
maintainer. `exact-mixed-transparency` therefore stays in the published blocker
tuple, and readiness gains the capability `nearest-glass-split`.

Eligibility: perspective and orthographic (later passes reuse the frame's
geometric-depth colour variants through `OpaqueVisibilityPass.resume`), 1x and 4x
MSAA, flat, quantized, instanced, individual-mesh and X-Ray ghost draws, section
clipping (shared fragment discards) and selection. Reported fallbacks (single pass,
`compositionReport.fallback`): `single-pass-mode`, `pipelines-compiling` (the
depth-only variants compile asynchronously; the frame re-renders when they are
ready), `unsupported-draw` (an unregistered pipeline or pass command), and
`upstream-interval-missing`. Frames without visible splats record no extra pass,
attachment, texture, query or pipeline; this is asserted by a spy in
`renderer-render-paths.test.ts`.

Rules in split frames: the selection highlight keeps its rule of drawing over
transparent IFC, so on the highlighted surface it also covers splats behind the
nearest layer (`highlightOverSplats`). Points, reference images and overlays stay in
the main pass, so glass now blends over those behind it. Only transparent IFC
meshes take part.

### Evidence (manual, through `ifc-gpu-check`)

| witness | reference | SwiftShader | NVIDIA (Blackwell, Windows Chrome 156 over CDP) |
| --- | --- | --- | --- |
| `validate-native-adapter.mjs`, glass scenes: perspective and orthographic x 1x and 4x, each at two canvas sizes | affine: B0 + (B1 - B0) A / 255 from the glass over black / white and the splat alone; front splat, rest of frame and no-glass frames byte-equal to the single pass | pass, max 0.957/255 | pass, max 1.239/255 (4x), 0.925/255 (1x) |
| same, two panes and X-Ray | `transparentLayers` must be `multiple`; one pane must be `single` (negative control) | pass | pass |
| full native witness (all earlier scenes) | as recorded above | pass | pass |
| `peel-validate.mjs`: option B vs the K-layer peel witness, single-pane and five-pane scenes, 3 sizes, both projections | per sample: <= 1 layer equal to the independent per-sample reference and to the K-layer peel (tolerance 0); >= 2 layers anywhere: `multiple` reported; split-off control must miss | 1x exact; 4x every mismatch explained by SwiftShader's x-mirrored fixed-function sample depth (probed) | exact at 1x and 4x, every case |
| `--real-glass`: FZK-Haus (its windows) + plant capture (Marcel Padilla, CC-BY-4.0) behind a window | independent affine reference (front window only), and the K-layer research renderer (`5b9b7f6f6d`) | not run | affine max 1.8/255; vs K-layer max 3/255, no pixel beyond the two renderers' existing glass-shading delta + 2/255; single pass vs K-layer mean 22.8 (max 39) |
| `--ifc-regression`: IFC-only frames incl. glass, X-Ray, partial transparent batches, selected glass, orthographic | base `750b33165a` | 10/10 identical | 10/10 identical |

Tolerances: 2/255 only for the affine references (each capture is rounded once, so the
true composite lies within 1/255; hardware blend rounding needs the second LSB). The
113k-splat capture jitters frame to frame by up to 3/255 on fewer than 0.1 % of
channels in every renderer and mode (also in the single pass); this is disclosed
and not used as a tolerance. Back-window pixels of the real asset, where glass lies
behind the capture, are beyond exact and only reported.

Mutation evidence: `tests/evidence/gaussian-8564-split-*` (compare sides, recorder
hold, nearest vs farthest P1, fallback reporting) are OBSERVED by the revert
oracle. With the compare-side mutation applied, the GPU glass witness fails its
reference, front-equality and rest-equality checks in every scene.

```sh
~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/contract/validate-native-adapter.mjs --backend=swiftshader|hardware
~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/contract/peel-validate.mjs --backend=swiftshader|hardware
node examples/gaussian-splat-spike/prepare.mjs   # fixtures for --real-glass
~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/contract/validate-native-adapter.mjs --backend=hardware --real-glass=/abs/k-layer/checkout
```

Still blocked: splats between transparent layers, the X-Ray policy, scalable GPU
ordering, per-fragment clipping and caps, hardware memory and frame-time budgets,
and the qualified native-viewer contract.
