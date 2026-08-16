---
'@ifc-lite/viewer': patch
---

Fix an orphaned clash intersection-solid render surviving the clash tour and Home / "Show all".

`focusClash` (`apps/viewer/src/hooks/useClash.ts`) computes the true intersection solid for a focused clash pair asynchronously, ghosts the whole model, and draws the solid opaque. The in-flight compute was staled out by `solidRequestGuard`, a `useRef` private to one `useClash()` hook instance — no code outside that hook's own callbacks could ever invalidate it.

Two teardown paths reset the same fields `useClash.clearHighlight()` resets (selection, isolation, ghost, pair colours, the contact overlay, `clashSelectedId`) directly against the store, written before the on-demand solid feature landed:

- the clash tour's "zoom-to-clash" step cleanup (`apps/viewer/src/lib/tours/tours/clash.ts`)
- the Home / "Show all" reset, `resetVisibilityForHomeFromStore` (`apps/viewer/src/store/homeView.ts`)

Neither called anything that could invalidate the guard, so running the clash tour to completion, or clicking Home / "Show all", while a clash solid was showing (or its compute was still in flight) left an orphaned opaque intersection-solid mesh rendering with nothing selected and no clash focused — or let a since-superseded compute land afterward and reapply the full-model ghost the user had just cleared.

Rather than adding `clearClashSolid()` calls at these two sites (which would leave the same gap for the next teardown path that forgets to), the invalidation now lives in the clash store slice itself: `setClashSelectedId`, `clearClashSolid` and `clearClash` (`apps/viewer/src/store/slices/clashSlice.ts`) all reset the solid presentation and bump a new `clashSolidRequestSeq` counter. `focusClash`'s async compute checks that counter instead of a private ref, so any code path that changes or clears the focused **clash** — including ones not written yet — invalidates an in-flight solid compute by construction. `Viewport.tsx` additionally gates the solid draw on `clashSelectedId !== null` as defence in depth.

That "by construction" property covers clash-*focus* teardown. The paths that replace or unload the **model** the presentation belongs to are a separate, pre-existing gap and touched no clash field at all, so a resolved solid and a non-null `clashSelectedId` both survived them — which meant the render gate passed too, and the previous model's solid was eligible to be re-pushed into the new scene when the renderer re-initialised. All three now route through the same store invalidation:

- `resetViewerState()` (`apps/viewer/src/store/index.ts`), the primary-file "open another model" reset, calls `clearClash()`. Same stale-model-reference class as the `compareResult` / `zoneAssignments` / `searchIndexes` drops beside it — a clash result is keyed by `model:expressId` pairs from the outgoing model, and an IFCX recomposition reassigns expressIds outright.
- `clearAllModels()` (`apps/viewer/src/store/slices/modelSlice.ts`) calls `clearClash()`: a full federation teardown leaves nothing for a solid to be drawn against.
- `removeModel()` drops the focused-clash **presentation** but keeps the clash **result**: the result is a list the user is reading, while the solid is a mesh in the live scene whose model set just changed under it.

Clash presets and settings are workspace preferences and survive all three, as they do everywhere else `clearClash` is called.

The solid is not the only thing `focusClash` draws, though, and the same "one decision, several spellings" shape produced a second ghost. Ending a clash focus means clearing the A/B pair tint, the contact marker (`clashContactLines`, or the `clashOverlapBox` AABB fallback) and the solid — but that field list was written out by hand in seven callers, and they had drifted to different subsets. `Viewport.tsx` draws the contact marker from an effect keyed on `[clashOverlapBox, clashContactLines, showClashRegionBox]` alone — it reads neither `clashSelectedId` nor `clashSolidStatus` — so a teardown that cleared only the solid and the selected id did not retract the wireframe. Two callers had that bug:

- `removeModel()` left the contact outline drawn in world space over models that had just been unloaded.
- `ClashPanel`'s unmount cleanup cleared `clashOverlapBox` but not `clashContactLines`, which is the field that carries the marker in the common case: `focusClash` prefers the real contact interface and nulls the box when it can build one. Closing the panel on such a clash left its outline behind.

Both are fixed by making the field list exist once. `clearClashFocus()` (`apps/viewer/src/store/slices/clashSlice.ts`) is now the single complete spelling of "stop drawing the focused clash" — tint, marker, solid, selected id and the `clashSolidRequestSeq` bump — and `clearClash` composes the same shared constant, so the two cannot drift. Every teardown path (`removeModel`, `ClashPanel`'s unmount, the clash tour cleanup, Home / "Show all", `useClash`'s `clearHighlight` / `clearAll` / pre-run discard) calls it instead of listing fields, so a teardown path added later is complete by construction rather than by remembering.

One half of that presentation lives in another slice, and so was still missed on the model-lifecycle paths. `focusClash` also takes ownership of the shared ghost channel (`ghostExceptEntities`, `visibilitySlice`): the X-Ray focus mode ghosts the pair's context, and the resolved-solid path ghosts the *entire* model (`installClashGhost(new Set())`) so nothing opaque buries the overlap. No clash action can reach that field, so `clearClashFocus()` could not clear it — focus a clash in a federated session, then remove the model it belongs to, and the solid, the marker and the selected id all went, while every surviving model stayed translucent with nothing selected and no way to tell why. `removeModel()` and `clearAllModels()` now end both halves through one helper in `modelSlice.ts`, so a third model-lifecycle teardown is complete by construction; `resetViewerState()` already nulled the field.

The ghost is deliberately *not* folded into the clash slice's shared `CLASH_FOCUS_RESET` constant, even though that is where the rest of the field list lives: `clearClashFocus()` is also called at run start, where the ghost must be released ownership-aware (`releaseClashVisibility`, matched by content against what clash itself installed) so that a user's own X-ray survives pressing Run. On the model-lifecycle paths the clear is unconditional instead, matching every other user-initiated end of a focus — the panel's Clear button, the panel unmount cleanup, the clash tour cleanup and `resetViewerState` all pair the focus clear with a bare `clearGhost()`.
