/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who owns the SHARED visibility channels while a clash is on screen — and the
 * one release that reads that ownership.
 *
 * `isolatedEntities` / `ghostExceptEntities` (visibilitySlice) are shared by
 * clash, "Isolate in 3D" (#2532), assembly isolation (#2531), `LayerDiffView`,
 * Space Sketch's `useSpaceGhostPreview` ("never clears state it didn't set"),
 * IDS/BCF isolation and `syncSourceModel`'s post-removal purge. A clash
 * teardown may therefore only release a presentation clash ITSELF installed.
 *
 * ## Why this is a store field and not a hook ref (#2654 third review)
 *
 * The record used to be two `useRef`s private to a `useClash()` instance, so
 * store-level teardowns (`removeModel`, `clearAllModels`, `resetViewerState`)
 * could not read it and had to INFER ownership from `clashSelectedId`. That
 * inference is wrong in both directions, with running reproductions:
 *
 *  - OVER-CLEAR. `applyFocusMode`'s `highlight` branch clears both channels and
 *    owns neither afterwards, yet `clashSelectedId` stays set. Focus a clash in
 *    highlight mode, let LayerDiff / Space Sketch / X-ray install a ghost, then
 *    remove a model — that owner's ghost was destroyed. On the `syncSourceModel`
 *    path this is the original #2654 regression: `removeModel` nulls the ghost
 *    and `purgeStaleEntityState` one line later reads `null` and skips its
 *    filter, so "Sync from source" wipes the user's X-ray.
 *  - UNDER-CLEAR. `useClash.selectElement` installs a NON-EMPTY clash-owned
 *    isolation via `applyFocusMode` and never writes `clashSelectedId` (and
 *    `run()` ends by nulling it). The isolation survived `removeModel`, so
 *    `isEntityVisible` returned false for everything — a blank viewport.
 *
 * Ownership is a fact clash already had; it just lived somewhere the store
 * could not see. It now lives in the clash slice (`clashVisibilityOwned`),
 * written by the two install helpers, and both the hook's run-start release and
 * every model-lifecycle teardown go through `releaseOwnedClashVisibility` here.
 * There is exactly one record and exactly one predicate over it, so the ref/
 * store pair that would otherwise have to agree does not exist. This mirrors
 * `lensRuleIsolation` / `lensAppliedHiddenIds`, the lens slice's own store-held
 * ownership bookkeeping for the same channels.
 */

/**
 * What clash last installed into a shared visibility channel, and which one.
 * `null` means clash owns neither channel — including after a `highlight`-mode
 * focus, which deliberately clears both and takes ownership of neither.
 *
 * The installed CONTENT is kept, not just the channel name, because ownership
 * is tested by value: see `releaseOwnedClashVisibility`.
 */
export type ClashVisibilityOwnership =
  | { channel: 'ghost' | 'isolate'; ids: ReadonlySet<number> }
  | null;

/**
 * Content equality for the ownership record. The shared channels are only ever
 * REPLACED wholesale (every slice setter stores a fresh `Set`), never mutated
 * in place, so equal members mean the channel still shows exactly the
 * presentation clash installed.
 *
 * Ownership is tested by VALUE, not by `Set` reference: reference identity
 * would be exact, but it is destroyed by every flow that snapshots and later
 * restores the channel with equal content in a fresh `Set` — Space Sketch's
 * open/close view capture (`useSpaceSceneFraming` clones the prior sets and
 * replays them through the cloning slice setters) and a source-model resync
 * (`syncSourceModel` rebuilds the kept sets even when nothing was filtered).
 * Under reference identity those flows silently converted a clash-owned focus
 * into "user" state, so the next run replaced the result set but left the old
 * pair isolated/ghosted (#2662 P2). Value identity survives any content-
 * preserving rewrite, and its one false positive is harmless by construction:
 * it only fires when the channel shows EXACTLY the presentation clash
 * installed, in which case releasing it renders precisely what discarding the
 * clash focus should render.
 */
export function sameMembers(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** The store surface `releaseOwnedClashVisibility` reads and writes. Every
 *  member is optional: `modelSlice`'s own tests drive the model actions through
 *  a harness that stubs `get()` with the model slice alone, so a slice reaching
 *  across must tolerate genuinely absent fields rather than assume the combined
 *  store. */
export interface ClashVisibilityChannels {
  ghostExceptEntities?: Set<number> | null;
  isolatedEntities?: Set<number> | null;
  clashVisibilityOwned?: ClashVisibilityOwnership;
  clearGhost?: () => void;
  clearIsolation?: () => void;
  setClashVisibilityOwned?: (owned: ClashVisibilityOwnership) => void;
}

/**
 * Release the isolation/ghost presentation clash itself installed — and ONLY
 * that. Isolation or ghosting established by another feature does not
 * content-match the ownership record, so it survives untouched.
 *
 * The record is dropped either way: once this has run, clash makes no further
 * claim on the channel. A record that no longer matches is inert anyway — the
 * channel it names has since been overwritten or cleared by someone else —
 * which is what makes the paths that clear both channels by hand
 * (`ClashPanel`'s unmount, `useClash.clearHighlight` / `clearAll`, the clash
 * tour cleanup) safe without each having to remember to reset it.
 *
 * @returns whether a channel was actually released — i.e. whether clash was
 *   still, verifiably, the owner. Callers use this as the ownership answer for
 *   the paint channel too (see `endClashScenePresentation`).
 */
export function releaseOwnedClashVisibility(state: ClashVisibilityChannels): boolean {
  const owned = state.clashVisibilityOwned ?? null;
  if (!owned) return false;
  const current =
    owned.channel === 'isolate'
      ? state.isolatedEntities ?? null
      : state.ghostExceptEntities ?? null;
  const stillOurs = current !== null && sameMembers(current, owned.ids);
  if (stillOurs) {
    if (owned.channel === 'isolate') state.clearIsolation?.();
    else state.clearGhost?.();
  }
  state.setClashVisibilityOwned?.(null);
  return stillOurs;
}

type ColorOverrides = Map<number, [number, number, number, number]>;

/** The cross-slice fields and actions a model-lifecycle teardown reaches for,
 *  on top of the visibility channels above. All optional, for the same reason. */
export interface ClashSceneTeardown extends ClashVisibilityChannels {
  clearClashFocus?: () => void;
  clearClash?: () => void;
  setPendingColorUpdates?: (updates: ColorOverrides) => void;
  clashHighlightColors?: ColorOverrides | null;
  lensAppliedColors?: ColorOverrides | null;
}

/**
 * End the clash presentation a model-lifecycle path is about to invalidate —
 * the ONE spelling of it, shared by `removeModel`, `clearAllModels` and
 * `resetViewerState`, so a fourth teardown path added tomorrow is complete by
 * construction rather than by remembering a field list (#2654 review).
 *
 * The presentation spans three channels, only the first of which the clash
 * slice can reach on its own:
 *
 *  - the clash slice's own focus fields (solid, contact marker, pair-tint
 *    RECORD, selected id, `clashSolidRequestSeq` bump) via `clearClashFocus` /
 *    `clearClash`, the slice's complete spellings of that teardown;
 *  - the SHARED VISIBILITY channels, released through
 *    `releaseOwnedClashVisibility` — ownership, not inference. Left behind, a
 *    clash ghost leaves the survivors translucent, and a clash isolation
 *    (which `selectElement` installs with nothing selected) hides the scene
 *    outright with no way to tell why (#2654);
 *  - the PAINT channel (`pendingColorUpdates`, dataSlice). `clashHighlightColors`
 *    is only a record; the albedo override the user actually sees is pushed
 *    separately (`useClash.focusClash`) into a fire-and-forget effect
 *    (`useGeometryStreaming.ts` → `scene.setColorOverrides`) that is undone
 *    only by a LATER push. Clearing the record alone leaves the amber/cyan pair
 *    painted on models that survived, and suppresses lens colouring with it.
 *    Every user-initiated end of a focus therefore ends with
 *    `setPendingColorUpdates(lensAppliedColors ?? new Map())` —
 *    `useClash.clearHighlight` (whose comment names this exact failure, "#1277
 *    review"), `useClash.clearAll`, `ClashPanel`'s unmount cleanup and the
 *    clash tour cleanup. Note `null` is a NO-OP in that effect; only a non-null
 *    EMPTY map reaches `clearColorOverrides()`, which is why the release always
 *    passes a `Map`.
 *
 * The paint channel has no ownership record of its own, so it is released on
 * the two facts that do mean clash painted: a recorded pair tint
 * (`clashHighlightColors`, written only by clash), or a visibility release that
 * verifiably succeeded — `focusClash` always paints when it installs, and the
 * resolved-solid path nulls the tint record while keeping the ghost, so that
 * second disjunct is what covers it. An unrelated model removal therefore
 * cannot switch off Pset / IDS / schedule colouring clash never took.
 *
 * `mode` distinguishes the two situations:
 *  - `'model-removed'`: one model leaves a federation. The clash RESULT is
 *    kept (a list the user is reading, not scene geometry; a sibling leaving
 *    does not invalidate pairs that do not involve it), and the visibility
 *    release is ownership-scoped — `syncSourceModel` calls `removeModel` and
 *    then `purgeStaleEntityState`, which KEEPS the part of a surviving model's
 *    X-ray and drops only the ids burned with the replaced one. Clearing a
 *    channel clash does not own makes that filter dead code on its only
 *    production path.
 *  - `'federation-cleared'`: every model is gone (`clearAllModels`,
 *    `resetViewerState`). The result goes too, both channels are cleared
 *    outright — there is nothing left for either to refer to, and no purge
 *    follows to salvage a survivor's ids — and the paint channel is released to
 *    an EMPTY map rather than to `lensAppliedColors`: those overrides are keyed
 *    by the outgoing models' global ids, so replaying them would paint the next
 *    scene with the previous one's colours.
 *
 * This is also why the visibility fields stay OUT of the clash slice's shared
 * `CLASH_FOCUS_RESET`: `clearClashFocus()` is ALSO called at RUN START
 * (`useClash.discardSolidPresentation`), where the release must be ownership-
 * aware for the same reason — #2662 P2. Adding them to that constant fails
 * `useClash.run-preserves-isolation.test.tsx` ("a user-established X-ray ghost
 * SURVIVES run()"), verified.
 *
 * @param read re-reads the store. Taken as a thunk, not a snapshot: the
 *   callers run other cross-slice clears (`clearMutations`, `clearMutationView`,
 *   `removeSourceTag`, and `resetViewerState`'s whole `set()`) before reaching
 *   here, each of which commits a new state object. A snapshot captured before
 *   those would read ownership off a pre-mutation object — benign today, a live
 *   trap the moment one of them touches a field read here.
 */
export function endClashScenePresentation(
  read: () => ClashSceneTeardown,
  mode: 'model-removed' | 'federation-cleared',
): void {
  const cross = read();
  const wipeAll = mode === 'federation-cleared';
  // Sampled BEFORE the clash clear nulls it.
  const clashPainted = cross.clashHighlightColors != null;

  if (wipeAll) cross.clearClash?.();
  else cross.clearClashFocus?.();

  let released: boolean;
  if (wipeAll) {
    cross.clearIsolation?.();
    cross.clearGhost?.();
    cross.setClashVisibilityOwned?.(null);
    released = true;
  } else {
    released = releaseOwnedClashVisibility(cross);
  }

  if (wipeAll) cross.setPendingColorUpdates?.(new Map());
  else if (clashPainted || released) {
    cross.setPendingColorUpdates?.(new Map(cross.lensAppliedColors ?? []));
  }
}
