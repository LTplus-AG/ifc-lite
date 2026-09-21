# Renderer relative-to-eye migration (#5049)

## Invariant

The renderer has one camera-owned relative-to-eye (RTE) frame. World/source
coordinates remain JavaScript f64 values on the CPU. At a GPU boundary an
f64 `(drawable origin - camera origin)` delta is split into `high` and `low`
f32 vec4 lanes; a shader evaluates `(local + deltaHigh) + deltaLow`. It never
subtracts independently rounded camera and drawable lanes. The per-draw delta
is therefore camera-dependent and must be regenerated whenever the frame
camera changes. The camera view-projection carries orientation and projection,
but no camera/world translation.

`packages/renderer/src/relative-to-eye.ts` and
`packages/renderer/src/shaders/relative-to-eye.wgsl.ts` own this contract. A
new pass must consume those helpers rather than make another rebase or invent
another high/low layout.

## Supported envelope and acceptance tolerances

These are renderer limits, not a promise that arbitrary Float32 geometry is
survey-grade. Source/world positions, model placements, camera pose, clipping
planes and measurements are finite f64 metres with an absolute component no
larger than `1e9`. `splitFloat64ForRte` enforces this limit, in addition to
rejecting non-finite values. `RelativeToEyeFrame.packDrawableOrigin` also
enforces `abs(drawableOriginAxis - cameraAxis) <= 1e6 m`; a remote camera and
drawable must be partitioned/reframed instead of being silently packed. The
initial supported drawable-local envelope is `abs(localAxis) <= 1e6 m`; it is
a safety envelope, not the precision target. Batch partitioning must keep
local axes within `8192 m` for the normal precision target (one f32 ULP is at
most 0.9765625 mm there).

The geometric comparison tolerance for a migrated GPU path is
`max(0.001 m, 2 * f32Ulp(maxAbsEyeRelativeAxis)) + 0.5 *
f32Ulp(maxAbsSourceLocalAxis)`. The first term budgets f64 delta splitting and
the two final f32 additions; the second separately states the error already
present when source-local geometry was uploaded as Float32. CPU source-space
ray, snap and measurement results remain f64 and use their existing
operation-specific tolerances. At the `1e6 m` emergency envelope the allowed
GPU geometric error is consequently about 0.15625 m for a maximally large
local vertex, so an oversized batch is valid but must be partitioned before it
can be used for precision-sensitive snapping.
Screen-space agreement is at most 0.5 physical pixel for colour/overlay edges
and at most 1 physical pixel for asynchronous ID/depth picking, measured at
the active drawing-buffer resolution.

The authored camera pose remains observable even when malformed. The RTE
frame uses the same scrubbed effective eye as `lookAt`, so malformed setters
remain non-throwing and CPU picking agrees with the matrix fallback. A finite
eye outside the supported envelope marks the frame unavailable: consumers
cannot accidentally read the preceding frame as current. Direct RTE updates
validate before publication, and matrix getters return owned copies.
The RTE frame is rebuilt after every accepted pose,
projection, viewport or model-placement change and carries the render epoch
used by asynchronous pick readback. Perspective/orthographic near/far guards
remain in `camera-matrices.ts`; RTE never relaxes their finite-range checks.

Real-GPU evidence is mandatory before the LandXML refusal can move: WebGPU
buffer readback must execute the common RTE WGSL helper on an adapter with
`navigator.gpu`, at the offsets and boundaries in the acceptance cases below.
This repository's node test environment has no WebGPU adapter, so its focused
test is a structural CPU/WGSL reflection gate rather than a substitute for that
evidence. Record browser, adapter, OS, pixel ratio and readback values in the
implementation PR.

## Inventory and migration order

The first production consumer is `CameraProjection`: screen projection forms
the f64 world-minus-eye delta before applying the shared translation-free
matrix; perspective unprojection inverts that matrix directly and returns an
f64 source-space ray. Orthographic rays retain their shared f64 `viewBasis`.
Camera tests exercise centimetre separation and source-plane intersections
under a common five-million-metre translation in both projection modes.
This proves the CPU camera slice, not agreement with every GPU pass. The
format-neutral georeferencing work in #5048 is still an unmerged dependency;
this slice changes neither authored coordinates nor model/source identities.

| Family | Current absolute boundary | RTE completion criterion |
| --- | --- | --- |
| Camera matrices, projection and frustum | `camera-matrices.ts`, `camera-projection.ts`, `index.ts` | Maintain f64 camera/target state; issue the translation-free matrix only to GPU consumers. CPU projection/unprojection obtains the same frame explicitly rather than silently reusing absolute `viewProj`. |
| Flat, quantized, textured and hydrated mesh draws | `index.ts`, `pipeline.ts`, `main.wgsl.ts`, `textured.wgsl.ts`, `scene-batch-*`, `scene-derived-mesh-provenance.ts` | All use one frame uniform plus a camera-dependent packed drawable-origin delta. Shared-origin partitioning preserves source/model/geometry-item provenance; local vertex buffers and quantized dequantization stay local. Repack or reframe before every draw after a camera change. Fragment `worldPos`, section planes and crop boxes use the same relative frame. |
| GPU instancing | `instanced-render.ts`, `main.wgsl.ts`, `picker.ts`, `shadow.wgsl.ts` | Remove national-grid translation from the f32 occurrence matrix; supply an origin per occurrence or a verified shared origin. The colour, picker and shadow records must have one identical layout, preserving canonical placed Y-up metres with scale then rotation then translation. |
| Shadows | `shadow-pass.ts`, `shadow-occluders.ts`, `shadow-light-matrix.ts`, `shadow.wgsl.ts` | Rebase the light transform around the f64 camera/drawable frame rather than reintroducing an absolute f32 translation. Section/crop, height ranges, culling and shadow fit use the same source-space inputs and shadows agree with clipped colour geometry. |
| GPU picker and rectangle selection | `picker.ts`, `pick-uniforms.ts`, `pick-resolve.ts`, `scene-rect-select.ts` | Pick rasterization and depth unprojection use the RTE frame. Capture the view/projection, camera and drawable origins plus a render epoch before asynchronous readback; reject stale samples. The decoded hit returns source f64 coordinates; no absolute f32 round trip is permitted. |
| Point picker and point clouds | `point-picker.ts`, `pointcloud/point-*`, `point-cloud-transform.ts` | Asset transforms and point nodes provide high/low origins; screen-space splat sizing, picking and point-cloud ray transforms agree with triangle geometry. |
| Highlight and overlay geometry | `index.ts`, `renderer-overlays.ts`, `symbolic-overlay-pipelines.ts`, `section-2d-overlay.ts`, `section-plane.ts`, `clash-solid-pipeline.ts`, `reference-image-pipeline.ts` | Every world-space overlay gets the exact camera RTE frame and its own packed anchor. The absolute `Float32Array` line-overlay API is anchored/rebased at its ingress. Screen-space-only passes need no origin but must not receive an absolute camera translation. |
| Clip/section/crop | `render-section-plane.ts`, `clip-box.ts`, `section-plane.ts`, main/picker/shadow/point shaders | Convert plane distance and crop bounds once from source f64 into the active eye-relative frame. Colour, picker, shadow and point discards make the same decision. |
| CPU raycast, snap, measure and deviation | `raycaster.ts`, `raycast-engine.ts`, `scene-raycaster.ts`, `snap-*.ts`, `point-cloud-ray-transform.ts`, `deviation/triangle-bvh.ts`, `deviation/deviation-*.ts`; viewer measurement adapters | Preserve source f64 throughout. Use `RelativeToEyeFrame.worldToRelative` only where a camera-relative calculation is needed; results are converted back exactly once. |

## Required acceptance cases

1. A mesh, textured mesh, quantized batch, instance and point at a 2–6 million
   metre offset retain a centimetre-scale separation when the camera is nearby.
2. Colour, shadow, picker, highlight and section/crop agree on a selected,
   clipped triangle at that offset.
3. GPU and CPU picks land on the same source f64 point; snap and measurement
   distances are invariant under a common multi-million-metre translation.
4. A one-model scene and an N-model federation preserve the existing registry
   identity rules while their model placements are RTE packed.
5. A real WebGPU compute/readback witness executes the helper with local axes
   at `±1e3`, `±1e4` and `±1e6`, on both sides of f32 exponent boundaries and
   with a remote camera/common source translation. Its accepted cancellation
   witness pins camera `10,000,000`, drawable `10,999,999.975`, local
   `-1,000,000` to `-0.02500000037252903`; the old association returns zero.
   The positive `11,000,000.025` version remains a documented *out-of-envelope*
   diagnostic, because its delta is `1,000,000.025 m`.

The LandXML safety refusal remains until all five cases cover the real renderer
paths above. It is intentionally out of scope for the foundation commit.
