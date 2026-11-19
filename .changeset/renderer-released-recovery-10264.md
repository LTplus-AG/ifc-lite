---
"@ifc-lite/renderer": minor
---

`Renderer.setReleasedSceneRebuild(rebuild | null)` lets `recoverDevice()` recover a scene whose CPU geometry was released (#10264). Without a registered rebuild such a scene is still refused with `cpu-geometry-released`.

With one registered, recovery works as follows:
1. The renderer replaces the device as usual.
2. It resets the scene's flat and instanced GPU state while keeping model placements.
3. It calls the host's `ReleasedSceneRebuild` with a `ReleasedSceneRebuildContext`: the replacement device, pipeline and scene, plus an `isCurrent()` fence. The host puts its geometry back from its own storage, flat through `replayReleasedGeometry` and instanced through `Scene.addInstancedShard`.
4. Readiness is published only after the rebuild resolves `true` under the same fence. Restaged instance template vertices are released again, so recovery keeps no CPU geometry.

A newer init/destroy supersedes the recovery. A loss of the replacement device, or a rebuild that resolves `false`, leaves the renderer lost with `scene-restore-failed`, so the host may retry. `Scene.resetReleasedForRebuild()` is the reset step.
