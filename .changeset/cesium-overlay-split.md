---
"@ifc-lite/viewer": patch
---

Split `CesiumOverlay.tsx` into the four responsibilities it had accumulated.

The file had grown past 1,000 lines carrying the Cesium viewer's lifecycle, the coordinate bridge, the model lifecycle and the solar study at once — four subjects with four different histories, interleaved. It is now 377 lines and reads as what it is: create the viewer, render the container, and call four hooks in the order their effects used to sit in.

`cesium/useCesiumBridge` owns where the model sits (ENU/ECEF framing, grid convergence, geoid undulation, terrain clamping, placement drafts). `cesium/useCesiumModel` owns what is drawn (GLB build, readiness-gated swap, matrix updates). `cesium/useCesiumSolar` owns lighting, shadows, the sun-path dome and the sky. `cesium/useCesiumCameraSync` owns the per-frame camera mirror, and `cesium/cesium-module` the lazy CesiumJS import they share.

Behaviour is unchanged, and the ordering that makes it unchanged is now written down: within a component React runs effect setups AND cleanups in declaration order, so the viewer effect — declared first — also cleans up first, and nothing in a later hook's cleanup may assume a live scene. Each hook documents where it must be called and what that buys it. Two teardown paths that the viewer effect cannot reach on unmount — the model's and the solar study's — are exposed as explicit `invalidate()` callbacks rather than left implicit.
