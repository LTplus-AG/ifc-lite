---
'@ifc-lite/renderer': minor
'@ifc-lite/embed-protocol': patch
'@ifc-lite/embed-sdk': patch
---

Implement the embed viewer's `?controls=` param / `EmbedOptions.controls` (#2934). It was parsed since the embed shipped and never applied — there was no gate anywhere in the camera controller to restrict orbit, pan, or zoom against.

`@ifc-lite/renderer`'s `Camera` gains `setInteractionMode('orbit' | 'pan' | 'all' | 'none')`, implemented at the single choke point every gesture already shares (`CameraControls.orbit`/`.pan`/`.zoom`), so mouse, touch, keyboard, and spacemouse input are all restricted together: `'orbit'` allows only orbit, `'pan'` only pan, `'none'` freezes the view (orbit, pan and zoom), `'all'` is unrestricted (the default, unchanged for every existing consumer). Programmatic moves — `setCameraRotation`, `setPresetView`, `zoomExtent`, `frameBounds`, and therefore the embed's `SET_CAMERA` command and `?camera=`/`?view=` params — are untouched by any mode. That includes the SpaceMouse fit buttons, which call `frameBounds`/`zoomExtent` directly and so still reframe the view under `controls=none`.

`@ifc-lite/embed-protocol` and `@ifc-lite/embed-sdk` had their `controls` (and, leftover from the earlier #2934 fixes, `hideAxis`/`hideScale`) doc comments corrected from "NOT YET IMPLEMENTED" to describe the real behaviour — no type changes.
