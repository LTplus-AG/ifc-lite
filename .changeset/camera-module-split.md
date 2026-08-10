---
"@ifc-lite/renderer": patch
---

Split the camera module family along its subject seams. `camera-animation.ts` gave up free framing (`camera-framing.ts`, pure pose pickers), the ViewCube's preset directions (`camera-preset-view.ts`) and first-person navigation (`camera-first-person.ts`); `camera.ts` gave up matrix derivation (`camera-matrices.ts`); the shared `CameraInternalState`/`ProjectionMode` types moved out of `camera-controls.ts` into `camera-state.ts`. No public API change.

The split surfaced six pre-existing defects in the code it moved, all fixed here:

- `enableFirstPersonMode` now actually gates `moveFirstPerson`. The flag was written and never read, so an embedder driving `moveFirstPerson` walked the camera whether or not walk mode had been entered. Leaving walk mode, and `Camera.reset()`, now also drop the accumulated walk velocity so it cannot be spent as a lurch on the next model.
- Fit distances (`frameBounds`, `zoomExtent`, `setPresetView`) honour the horizontal field of view. On a portrait viewport (`aspect < 1`) the horizontal field is the narrower one, and a fit derived from the vertical field alone clipped the box it was asked to frame. Landscape viewports are bit-for-bit unchanged.
- `zoomExtent` on a degenerate box (`max === min` — a flat wall, a single point) no longer puts the camera on its own target.
- The orthographic near/far derivation brackets the scene when position and target coincide, instead of centring a range on the camera and clipping the model away.
- The orthographic projection backstop rejects a zero or negative half-height, not only a non-finite one.
- A non-finite `buildingRotation`, or a rotation-cycle index outside 0-3, no longer produces a non-finite preset pose.
