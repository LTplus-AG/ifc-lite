---
"@ifc-lite/renderer": patch
---

Split the camera module family along its subject seams. `camera-animation.ts` gave up framing (`camera-framing.ts`, pure pose pickers) and first-person navigation (`camera-first-person.ts`); `camera.ts` gave up matrix derivation (`camera-matrices.ts`); the shared `CameraInternalState`/`ProjectionMode` types moved out of `camera-controls.ts` into `camera-state.ts`. Internal reorganisation only — no public API or behaviour change.
