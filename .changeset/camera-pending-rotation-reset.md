---
'@ifc-lite/viewer': patch
---

Fix a session reset (loading a new primary file) replaying the outgoing model's camera rotation onto the incoming one.

`setCameraRotation` records the requested rotation in `pendingCameraRotation` as a replay buffer whenever no renderer has registered `setCameraCallbacks` yet, and replays it on the next `setCameraCallbacks` call regardless of which model that renderer belongs to. `cameraSlice`'s session-reset teardown cleared `cameraRotation` and `projectionMode` but left `pendingCameraRotation` untouched, so a rotation set before any renderer registered survived the reset and got replayed onto the next model's `Viewport` as soon as it mounted and called `setCameraCallbacks`.

The teardown now also clears `pendingCameraRotation` on a session reset, so a stale pending rotation can no longer leak across a file swap. One caller-visible trade-off: an embed host's `SET_CAMERA` sent before the first load's `resetViewerState()` is now dropped rather than replayed on that first load — the `?camera=` initial-view path is unaffected, since `EmbedViewer` polls for callbacks post-load and re-issues it independently.
