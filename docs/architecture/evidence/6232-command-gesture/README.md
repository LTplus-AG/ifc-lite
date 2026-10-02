<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# 3D command press ownership (#6232)

The native run uses the checked-in public `apps/viewer/public/samples/building-architecture.ifc`
(SketchUp 2024, IFC Manager 5.3.3), the real canonical file input, real camera
projection and raycasts, the actual command runtime, IFC mutation writer and
WebGPU renderer. `native-facts.json.gz` contains the lossless input header/hash,
source/base identity, served WASM hash, native pointer events, runtime/camera/history
observations, canonical physical wall endpoints, console messages and adapter facts.
The manifest hashes each archived artifact. The capture retains source
`a695734678d5c78206807921b4d173b8977f7162`; its original evidence commit changed
no functional paths. The later foreign-cancellation fix is qualified separately
through mounted real-engine tests and does not relabel this native capture.

Windows Chrome 154 used a fresh owned context/tab on the native NVIDIA Blackwell
adapter, with cross-origin isolation, visible/focused page and no page errors.
Actual GPU color readback is `committed-renderer.png`; the other images show the UI.
This is behavior evidence, not a performance measurement.

## Observed behavior

1. Load the sample through Open, enter Model, choose Create → Wall, hide the plan.
2. Disable magnetic snapping using the existing setting. Camera rays, geometry
   picking, workplane conversion and the command solver stay unchanged.
3. Click a first corner, then press and move the left pointer on the 3D canvas.
   The wall ghost follows the actual cursor; the camera and history stay fixed.
4. Release at the same integral CSS pixel used by the last move. The browser's
   resulting click writes exactly one wall and one undo entry. Its physical IFC
   endpoint matches the observed preview, within the writer's decimal precision.
5. Leave the command. One Undo removes that wall; Redo restores its endpoints.
6. Start Wall again and drag the middle button. The camera pans, history stays
   unchanged, and no wall corner is placed.

The run covers one actual loaded model. Mounted tests additionally use one and two
models, actual parsed IFC mutation views and the real room-layout WASM: room edits
commit one tagged undo batch, preserve quantities through Undo/Redo, and cancel on
pointer cancellation, lost capture, refused capture plus departure, window blur,
lost buttons, unmount and command replacement. With capture refused, a foreign
touch or pen cancellation preserves the owned mouse drag and its single commit.
Native room pointer capture,
federation interaction and Firefox are not established by these screenshots.

## Excluded diagnostic

`excluded-subpixel-expectation.json.gz` preserves the earlier native attempt. Its
assertion incorrectly compared a fractional PointerEvent move with the browser's
integer MouseEvent click, which resolved different screen pixels. It showed the
same fixed camera and single commit, but failed that endpoint assumption. It is
not counted as a passing run or as the original production regression. The final
run uses integral screen pixels and records actual event coordinates; no camera,
raycast, IFC writer or command handler was patched to make it pass.

## Qualification

The native capture source passed 15 mounted cases, nine related regression suites
and its recorded root checks. The successor at
`fb5cc7619929741daaf8c9780209241b48e9135e`, against main
`e79f27342beb01a6f30d9b63c44795ecd118f4de`, passed the full normal root Turbo
build (61 tasks), plain root typecheck (109 tasks, 3,234 test files), and 16
mounted command cases with no skips. Its production-revert oracle observed 45
passes, then 31 passes and 14 assertion failures, with restoration verified.
The surgical owner-cancellation oracle observed 16 passes, then 15 passes and
one assertion failure; the untouched test-only checkpoint independently
reproduced that same real room-drag failure before the fix. The original
test-only checkpoint also reproduced the camera/room routing defects.
Changed-file lint, module-size, MPL and source-assertion gates passed. Complete
CI, root lint and all review feedback are checked separately on the published
head before merge; this archive does not assert their outcome.
