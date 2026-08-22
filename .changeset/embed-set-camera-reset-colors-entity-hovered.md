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

For integrators, that second half is a behaviour change on a published surface
and not only a fix: `RESET_COLORS` no longer clears `pendingColorUpdates`. A
host that had been sending it to clear a lens, IDS, clash or schedule overlay
was relying on a side effect that is now gone, and must clear that overlay
through the command that owns it. `RESET_COLORS` only undoes `SET_COLORS`.

Also worth knowing before you rely on it: `RESET_COLORS` restores the entities
the viewer holds in its primary `geometryResult`, which is the FIRST loaded
model. In a federated embed with more than one model, `SET_COLORS` still
colours entities in the later models and `RESET_COLORS` does not restore them,
while both commands ack success. Single-model embeds — the common case — are
unaffected.

`ENTITY_HOVERED` was declared, exposed by the SDK, and never emitted — the SDK
tests passed because they fabricated the event themselves. The viewer's hover
pipeline was already there but gated behind a toolbar toggle the embed has no
chrome to offer; the embed now enables it and emits on each hover-target
change.

`SET_CAMERA`'s `zoom` field remains unapplied and is now documented as
reserved rather than silently dropped: it has no defined meaning on the viewer
side, and guessing one is worse than saying so.
