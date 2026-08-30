---
'@ifc-lite/renderer': patch
---

Fix `CameraAnimator`'s inertia loop half-applying a decaying orbit/pan/zoom gesture once `interactionMode` restricts it mid-decay.

`Camera.orbit`/`pan`/`zoom` already gate `resetPresetTracking()` and inertia-queueing on whether the underlying `CameraControls` call applied (a rejected gesture, e.g. under an embed `?controls=none`, must not half-apply). But `CameraAnimator.update()`'s own inertia loop calls the same `CameraControls` methods directly on every decay tick and discarded the boolean result, so it bypassed the gate a second time, one level down. The bug was invisible when a gesture was refused from the start (no velocity is ever queued), and only showed up when `interactionMode` flipped to a restricting value *while inertia from an already-applied gesture was still decaying*: every remaining tick still reset ViewCube preset-view tracking and reported `isAnimating: true`, keeping the render loop alive around a camera that was supposed to be frozen.

Each of the three inertia blocks now only runs its side effects when `CameraControls.orbit`/`pan`/`zoom` reports it applied. On refusal, that channel's velocity is also zeroed instead of left to decay — otherwise it would survive the frozen ticks and get spent in one jump the moment `interactionMode` is lifted back to `'all'`, even though the gesture that produced it was already rejected while frozen.
