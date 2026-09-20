# Renderer relative-to-eye migration (#5049)

## Invariant

The renderer has one camera-owned relative-to-eye (RTE) frame. World/source
coordinates remain JavaScript f64 values on the CPU. At a GPU boundary an
origin is split into `high` and `low` f32 vec4 lanes; a shader first subtracts
the drawable and camera high lanes, then their low lanes, and only then adds a
local vertex. The camera view-projection carries orientation and projection,
but no camera/world translation.

`packages/renderer/src/relative-to-eye.ts` and
`packages/renderer/src/shaders/relative-to-eye.wgsl.ts` own this contract. A
new pass must consume those helpers rather than make another rebase or invent
another high/low layout.

## Inventory and migration order

| Family | Current absolute boundary | RTE completion criterion |
| --- | --- | --- |
| Camera matrices, projection and frustum | `camera-matrices.ts`, `camera-projection.ts`, `index.ts` | Maintain f64 camera/target state; issue the translation-free matrix only to GPU consumers. CPU projection/unprojection obtains the same frame explicitly rather than silently reusing absolute `viewProj`. |
| Flat, quantized, textured and hydrated mesh draws | `index.ts`, `pipeline.ts`, `main.wgsl.ts`, `textured.wgsl.ts` | All use one frame uniform plus a packed drawable origin. Local vertex buffers and quantized dequantization stay local. Fragment `worldPos`, section planes and crop boxes use the same relative frame. |
| GPU instancing | `instanced-render.ts`, `main.wgsl.ts`, `picker.ts`, `shadow.wgsl.ts` | Remove national-grid translation from the f32 occurrence matrix; supply an origin per occurrence or a verified shared origin. The colour, picker and shadow records must have one identical layout. |
| Shadows | `shadow-pass.ts`, `shadow-occluders.ts`, `shadow-light-matrix.ts`, `shadow.wgsl.ts` | Derive light-space positions from the same f64 drawable/camera-frame reconstruction as the colour pass. Section/crop tests retain their source-space meaning and shadows must agree with clipped colour geometry. |
| GPU picker and rectangle selection | `picker.ts`, `pick-uniforms.ts`, `pick-resolve.ts`, `scene-rect-select.ts` | Pick rasterization and depth unprojection use the RTE frame. The decoded hit returns source f64 coordinates; no absolute f32 round trip is permitted. |
| Point picker and point clouds | `point-picker.ts`, `pointcloud/point-*`, `point-cloud-transform.ts` | Asset transforms and point nodes provide high/low origins; screen-space splat sizing, picking and point-cloud ray transforms agree with triangle geometry. |
| Highlight and overlay geometry | `index.ts`, `renderer-overlays.ts`, `symbolic-overlay-pipelines.ts`, `section-2d-overlay.ts`, `section-plane.ts`, `clash-solid-pipeline.ts`, `reference-image-pipeline.ts` | Every world-space overlay gets the exact camera RTE frame and its own packed anchor. Screen-space-only passes need no origin but must not receive an absolute camera translation. |
| Clip/section/crop | `render-section-plane.ts`, `clip-box.ts`, `section-plane.ts`, main/picker/shadow/point shaders | Convert plane distance and crop bounds once from source f64 into the active eye-relative frame. Colour, picker, shadow and point discards make the same decision. |
| CPU raycast, snap and measure | `raycaster.ts`, `raycast-engine.ts`, `scene-raycaster.ts`, `snap-*.ts`, `point-cloud-ray-transform.ts`; viewer measurement adapters | Preserve source f64 throughout. Use `RelativeToEyeFrame.worldToRelative` only where a camera-relative calculation is needed; results are converted back exactly once. |

## Required acceptance cases

1. A mesh, textured mesh, quantized batch, instance and point at a 2–6 million
   metre offset retain a centimetre-scale separation when the camera is nearby.
2. Colour, shadow, picker, highlight and section/crop agree on a selected,
   clipped triangle at that offset.
3. GPU and CPU picks land on the same source f64 point; snap and measurement
   distances are invariant under a common multi-million-metre translation.
4. A one-model scene and an N-model federation preserve the existing registry
   identity rules while their model placements are RTE packed.

The LandXML safety refusal remains until all four cases cover the real renderer
paths above. It is intentionally out of scope for the foundation commit.
