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
The manifest hashes each archived artifact. The recorded source precedes only this
evidence commit; no functional paths changed while packaging it.

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
lost buttons, unmount and command replacement. Native room pointer capture,
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

Against the recorded current main, normal root Turbo build and typecheck completed
successfully; 15 new mounted cases and nine related regression suites passed.
The official production-revert oracle had 44 passing assertions on the branch and
31 passing / 13 failing assertions after reverting production, with restoration
verified. The original test-only checkpoint independently reproduced camera/room
routing defects, before implementation. Lint, API surface, module-size, test-wiring
and source-assertion gates passed. Required CI and review are checked separately
on the final published PR head; this archive does not assert their outcome.
