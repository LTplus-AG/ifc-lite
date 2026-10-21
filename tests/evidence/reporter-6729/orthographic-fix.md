# Orthographic visibility fix — #6729

The defect is depth ownership. Orthographic entity ranking changed physical
occlusion: an adverse rear hash could win across a real 4mm gap as camera angle
changed. The prior 25mm displacement cap (#6734) protected 30mm witnesses but
could not protect smaller separations. The sample-correct selection change
(#7117) alone did not constrain the colour pass's displaced depth.

The paired invariant reproduced 96 failing orthographic cases out of 360 on
both Pop and PC before this fix. Perspective and identity-nudge controls passed.
The independent f64 ray/plane oracle establishes which plane is nearer without
using the production depth-rank formula.

## Shared implementation

`OpaqueVisibilityPass` replays the actual submitted depth-writing mesh draws
into unbiased, sample-matched geometric depth. It does not repeat model,
batching, visibility or instancing decisions. Colour and visible selection/hover
accept geometric nearest samples before applying the existing coplanar rank.
The original fragment's discards remain authoritative, including clipping and
texture cutouts. Perspective bypasses the pass. Intentional hidden selection
silhouettes retain their existing contract.

Both storage and acceptance use the same sample-interpolated depth. Comparing
a shader interpolant with fixed-function MSAA depth caused sample-position
mismatches on the tested backend; that failed prototype was rejected. Numerical
coincidence allows four float32 ULPs, independently of the entity hash. This
cannot promise ordering for arbitrarily small separations at arbitrary ranges.

## Recorded coverage

The initial implementation on the PC's observed SwiftShader backend:

- 2,160 recorded visibility rows pass (including 720 duplicate perspective controls): 1/4/30mm gaps, 5.2/40/1000m depth ranges,
  five orbit angles, both draw orders and projections, flat/quantized/instanced
  vertex stages, MSAA 1/4, production and identity-nudge controls.
- 240 real selection/hover mask cases pass, including maximal-rank hidden
  sources behind rank-zero 1mm occluders and deliberate hidden silhouettes.
- The actual textured fragment preserves transparent texels and opaque texels
  in both draw orders, including a partial indexed submission.
- Existing viewer tests pass for hidden rods over five poses, coplanar plate
  ownership on 40m/1km scenes, annotations, selection, colour overrides and
  near/far clipping. Their pixel assertions are unchanged. Tests now own a
  private source server; the combined suite preserves their original viewport.
- All 36 reduced-reporter frames pass functional capture with no recorded GPU
  errors: three poses, two scales, both projections and three selection states.
  Fixture SHA256 remains
  `cc6fbbf632c2779891e485c3297d437b1d8555448934b8c8b5a3cce5326553a2`.
- Root `pnpm typecheck` passes (4,245 test sources audited), as does root
  `pnpm test --filter=@ifc-lite/renderer -- --test-concurrency=1`: 2,169 passes,
  zero failures, two existing opt-in/unavailable-runtime skips. Package builds,
  API-surface comparison, module-size audit against the base, source-assertion
  guard and lint of the new implementation also pass.

Production implementation is pinned by `88d4b52625febf3ae5267e0c42c33590929012fc`;
subsequent commits adjust test wiring and evidence only. The final viewer cohort
ran `932a0796229ce3f70d9c2b83bb8f8a06481ce586`, worker receipt
`9a7c9ac1-149a-42f6-bdfa-3fbcbc2f04b8`, with actual WASM SHA256
`5ebb5c2e763c692c91cc984508aebdfc6c9ee568b454235cc89352792629b1e3`.
The root-check cohort used `986a1f698bb194cd97cc2cf39d90fe6eb0209996`;
its renderer implementation and unit tests match the final viewer source.

Run the synthetic and texture/mask witnesses with `pnpm test:projection-depth`.
After building the viewer dependencies and real WASM, run the full viewer
cohort with `DEPTH_WITNESS_VIEWER=1 E2E_GPU_STRICT=1
REPORTER_6729_IFC=/path/to/out_visible.ifc pnpm test:projection-depth`.
Use the documented Xvfb display setup where required, and preserve adapter
identity. `DEPTH_WITNESS_CHROME` selects an existing full Chromium binary.

## Limits retained in the evidence

The reporter recorder's disposition remains
`FUNCTIONAL_FRAMES_CAPTURED_OCCLUSION_VERDICT_PENDING`. Its shaded images are
not an independent numeric occlusion oracle. The 11-product reduced file is not
the original video's 40.8K-element assembly, and does not contain its target GUID.
No full-original-model, physical-GPU or performance acceptance is claimed.

Pop's full viewer cohort lost its software device with
`A valid external Instance reference no longer exists`; that failure is retained,
not counted as passing. PC's Xvfb cohort completed. Native adapter requests on
both machines still reported SwiftShader. Mac is disabled in fleet policy.
The additional orthographic opaque replay and depth32float MSAA attachment have
a real cost; frame-time overhead has not been benchmarked. Perspective avoids
the replay and attachment allocation, but that is not a measured speed claim.


## Review follow-up qualification

The current matrix removes the repeated perspective rows: 1,080 orthographic
cases across three ranges plus 360 perspective controls, 1,440 distinct cases.
Perspective uses the actual infinite-far matrix and records no finite range.
Review follow-ups compile visibility variants asynchronously before drawing,
defer frames while compilation is pending, reject failed variants without an
unconstrained fallback, and release the depth texture on perspective frames.
Fresh qualification on PC source `6f7da8e22` passed root `pnpm typecheck`,
2,172 renderer tests (zero failures, two existing skips), all six GPU witness
tests, and all five full viewer tests including the 36 reporter frames. The
matrix now executes 1,440 distinct cases; no extra range coverage is claimed
for perspective. PC receipt: `3e25f5b3-23a5-4867-a161-69c07989dcec`.
The initial implementation's measurements above are retained with their scope.
