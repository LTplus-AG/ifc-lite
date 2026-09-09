---
"@ifc-lite/sdk": patch
---

`bim.bcf.createViewpoint()` forwarded `ViewpointOptions` straight through to `@ifc-lite/bcf`'s `createViewpoint`, which expects a different shape. `ViewpointOptions.camera` is the documented `bim.viewer.getCamera()` shape (`{mode, position:[x,y,z], target:[x,y,z], up:[x,y,z]}`, tuples) while the library's `ViewerCameraState` uses `{position:{x,y,z}, target:{x,y,z}, up:{x,y,z}, fov, ...}` (objects); reading `.position.x` off an array is `undefined`, so every produced viewpoint silently had a `null`/`NaN` camera. `createViewpoint` now translates the tuple shape into the library's object shape (defaulting the field of view the SDK's camera shape never tracked).

`ViewpointOptions.sectionPlane` was forwarded to a library branch gated on `sectionPlane?.enabled && bounds`, and the SDK has no `bounds` field or method to produce one — an enabled section plane used to resolve successfully with the clipping plane silently missing from the result. `createViewpoint` now rejects an enabled `sectionPlane` with an error explaining the SDK cannot express it, instead of silently dropping it; a caller with its own model bounds can call `bim.bcf.sectionPlaneToClippingPlane` directly.

`camera.mode: 'orthographic'` had the same silent-wrong-shape problem: the adapter set `isOrthographic` but never `orthoScale`, and `@ifc-lite/bcf`'s `createViewpoint` only emits `orthogonalCamera` when both are present, so an orthographic camera silently fell into the `perspectiveCamera` branch. The SDK's `CameraState` carries no zoom/frustum-size value an `orthoScale` could come from (the real viewer adapter's `getCamera()` returns only `{mode}` today), so rather than invent one, `camera.mode: 'orthographic'` now throws — the same fail-loud choice already made for `sectionPlane`.

`bim.bcf.sectionPlaneToClippingPlane` also silently dropped its `bounds` argument — the very argument `createViewpoint`'s new `sectionPlane` error message tells callers to pass. The library requires `bounds` and throws a raw `TypeError` without it, so the recommended workaround crashed. `sectionPlaneToClippingPlane` now accepts and forwards `bounds`.
