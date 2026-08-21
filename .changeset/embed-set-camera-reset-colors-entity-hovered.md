---
'@ifc-lite/renderer': minor
'@ifc-lite/embed-protocol': patch
'@ifc-lite/embed-sdk': patch
---

Three embed API commands that reported success while doing nothing now work
(#2934). Each was broken at a different link in the chain.

`SET_CAMERA` had no actuator. The handler called the store's
`setCameraRotation`, which was `set({ cameraRotation })` and nothing more —
every orientation entry point on the camera was either relative (`orbit`, the
90° rotate steppers) or named a direction (`setPresetView`), so an absolute
azimuth/elevation pair had nothing to reach. The host got a `requestId` ack
*and* a `CAMERA_CHANGED` echo of its own numbers back, while the view never
moved. `Camera.setRotation(azimuth, elevation)` is new on `@ifc-lite/renderer`
— the exact inverse of `Camera.getRotation`, absolute and idempotent, keeping
the target and orbit distance, with the same pole clamp `orbit` uses — and the
store action now drives it the way `setProjectionMode` drives its own callback.

`RESET_COLORS` cleared the wrong channel, in both directions at once.
`SET_COLORS` bakes into the mesh colors, while `clearPendingColorUpdates`
empties the transient overlay channel the lens, IDS, clash and schedule
overlays own: the host's own override survived the reset, and another
subsystem's state was destroyed by it. `SET_COLORS` now marks its writes as an
override, which captures the colors it displaces, and `RESET_COLORS` restores
those and leaves the overlay channel alone. The loader's own IFC style pass is
deliberately not treated as an override, so a reset restores the model's IFC
colors rather than stripping them.

`ENTITY_HOVERED` was declared, exposed by the SDK, and never emitted — the SDK
tests passed because they fabricated the event themselves. The viewer's hover
pipeline was already there but gated behind a toolbar toggle the embed has no
chrome to offer; the embed now enables it and emits on each hover-target
change.

`SET_CAMERA`'s `zoom` field remains unapplied and is now documented as
reserved rather than silently dropped: it has no defined meaning on the viewer
side, and guessing one is worse than saying so.
