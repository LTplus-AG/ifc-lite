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

**RESET_COLORS restored the previous model's colours onto the current one.** `meshColorBackup` holds each element's ORIGINAL colour so the reset can put it back, and it was cleared in exactly one place, `resetMeshColors` itself, and in no teardown path. Its keys are global express ids and those are reused across a model swap, so a backup that outlived its model did not go inert: it named live elements of the next one, and `resetMeshColors` queued the departed model's colours into `pendingMeshColorUpdates` for the renderer to upload.

Reproduced against the real store before fixing: load A with entity 12 red, override it, `resetViewerState()`, load B with entity 12 blue, reset. Entity 12 came back A's red.

The map is also first-write-wins, so one leaked entry was permanent. A later override on the new model declined to record that element's real colour, because the id was already present, and every reset from then on restored the wrong one. It corrupted the feature for the rest of the session rather than for one reset.

Cleared now in `resetViewerState`, `removeModel` and `clearAllModels`, and the three are not the same clear.

`resetViewerState` and `clearAllModels` drop the map whole, because both restart the id space: `clearAllModels` calls `federationRegistry.clear()`, offsets go back to 0, and the next model genuinely is handed the ids the last one used.

`removeModel` purges only the removed model's entries, via `resolveGlobalIdInModel`, the owner-scoped resolver this slice already provides for exactly this question. Dropping the map whole there would take the SURVIVING models' undo with it, and it is not needed for them: `unregisterModel` BURNS the removed range rather than reclaiming it, so no later model can be handed those ids. An earlier draft of this fix did drop it whole, and the effect was worse than the bug in one respect: with a live override on a model that was not the one removed, `resetMeshColors` then had nothing to restore from, leaving the store and the GPU out of step with no action left to reconcile them.

**Module-size budgets, recorded deliberately and with the reason.** The gate that landed in #3045 requires either a split or a written justification for a raise, so here is the justification.

Seven files are raised and one row is added. Two of the raises are this fix's own lines, four in `store/index.ts` and thirteen in `store/slices/modelSlice.ts`; the other five and the new row are this PR's feature growth (`camera.ts` +71, `dataSlice.ts` +81, `EmbedViewer.tsx` +39, `types.ts` +12, `Viewport.tsx` +9, `handler.ts` +7).

Splitting was considered and rejected for `dataSlice.ts`, which is the one that matters: it crosses 400 for the first time, at 471. It is a Zustand `StateCreator` returning a single object literal, so dividing it is a restructure of the slice's shape rather than a file move, and doing that inside a bug-fix PR trades a contained change for a broad one. **That is debt, not a resolution**, and it should be split on its own.

One hazard worth naming for whoever resolves the next conflict here: `--update` re-records EVERY row that changed, not only the ones a PR touches. It silently pulled two rows for `packages/cli` and `packages/mcp` into this diff, packages this change never opens. Both are restored and the pin recomputed by hand, so the allowlist diff names only files this PR actually grows.

Worth stating for whoever tunes this gate next: **312 of its 314 rows sit at exactly their measured size on main.** A one-line fix to any of them trips it. This PR's two-line teardown fix did, and every future fix to an allowlisted file will arrive needing a split or a raise.


**One thing left standing, deliberately.** `pendingMeshRemovals`, `pendingMeshTranslations` and `pendingMeshRotations` are id-keyed exactly like `meshColorBackup` and are cleared in no teardown path either. `pendingMeshRemovals` is worse than the others, because it ACCUMULATES (`new Set(state.pendingMeshRemovals ?? [])`) rather than being overwritten, so a survivor merges into the next model's removals. `clearAllModels` also clears the backup but not `pendingMeshColorUpdates`, on the one path where offsets really do restart. All of that is pre-existing and none of it is what this PR broke, so it is named here rather than folded in.

**A fourth path leaked the backup, and it is the one an embed host hits.** The three teardown clears above do not cover `setGeometryResult` REPLACING geometry, and `useIfcFederation` calls exactly that on an ACTIVE-MODEL SWITCH: no reset, no removal. So switching models left the backup pointing at the model you came from. Reproduced, then fixed by clearing when the geometry's identity changes; a redundant set of the same object keeps a live undo, which is the mistake the `removeModel` clear made in its first draft.

That one was found by review on 2026-08-22, before this round started, and it is worth saying plainly that the three clears alone would have shipped looking complete.

**`SET_CAMERA` acked before the renderer existed.** `setCameraRotation` calls the actuator optionally and then records the pose, and `setCameraCallbacks` only stored the callbacks. An embed host sending SET_CAMERA before `Viewport`'s effect registers gets a success ack and a camera that never moves: success reported for something that did not happen. A rotation accepted with no actuator is now held and replayed on registration, and an already-applied one is not replayed, so registering a second renderer cannot re-fire it.

**`Camera.setRotation` propagated a non-finite TARGET.** The existing guard rejects non-finite ANGLES, and `isUsableDistance` rescues the radius, but every position component is `target.<axis> + ...` and `setTarget` accepts non-finite coordinates. One NaN there made the whole pose NaN, in a method whose contract is that it RECOVERS a pose. It now refuses, the same way it refuses non-finite angles.

**Two review findings are deferred rather than fixed, with reasons.** `dataSlice.test.ts` carries 19 `as any` casts on its mesh fixtures; typing the fixture properly is the right fix and is test-hygiene work on this PR's own suite rather than anything the fixes above touch. And the `ENTITY_HOVERED` tests cover only model-free ids, so the single-model and N-model federation cases are genuinely uncovered. Both are real; neither is a correctness defect, and folding either in would grow a change that has already grown three times.
