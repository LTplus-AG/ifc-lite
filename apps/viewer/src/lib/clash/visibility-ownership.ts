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

import {
  releaseOwnedVisibility,
  sameMembers,
  type VisibilityOwnership,
} from '../visibility/ownership.js';

/**
 * What clash last installed into a shared visibility channel, and which one.
 * `null` means clash owns neither channel — including after a `highlight`-mode
 * focus, which deliberately clears both and takes ownership of neither.
 *
 * The installed CONTENT is kept, not just the channel name, because ownership
 * is tested by value: see `releaseOwnedClashVisibility`.
 */
export type ClashVisibilityOwnership = VisibilityOwnership;

/**
 * Content equality for the ownership record — re-exported from
 * `lib/visibility/ownership.ts`, which now holds the one implementation.
 *
 * IDS's per-row focus (#2867) records and releases its own claim on the same
 * two channels, and two subsystems arbitrating the same channel with two
 * copies of the same predicate is precisely the shape that drifts. See that
 * module's doc for WHY ownership is tested by value and not by `Set`
 * reference (#2662 P2).
 */
export { sameMembers };

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
 * claim on the channel.
 *
 * A record that no longer matches is NOT inert — the earlier revision of this
 * doc claimed it was, and that claim was false (#2654 fourth review). Ownership
 * is tested by VALUE, so a stale record goes matching → cleared → MATCHING
 * AGAIN as soon as any other owner installs a set with equal content: focus a
 * clash in ghost mode, `clearHighlight()`, let the spaces X-ray install a ghost
 * over the same two ids, remove an unrelated model, and that owner's ghost was
 * destroyed. On the `syncSourceModel` path that is "Sync from source wipes the
 * user's X-ray" again — the very bug this file exists to close.
 *
 * What actually makes the by-hand "clear both channels" paths safe is that
 * `clashVisibilityOwned` is a member of `CLASH_FOCUS_RESET` (clashSlice), and
 * every one of them — `ClashPanel`'s unmount, `useClash.clearHighlight` /
 * `clearAll`, the clash tour cleanup, `homeView` — routes through
 * `clearClashFocus()` / `clearClash()`. The claim ends with the focus, by
 * construction. See the ordering note on `endClashScenePresentation`.
 *
 * @returns whether a channel was actually released — i.e. whether clash was
 *   still, verifiably, the owner. Callers use this as the ownership answer for
 *   the paint channel too (see `endClashScenePresentation`).
 */
export function releaseOwnedClashVisibility(state: ClashVisibilityChannels): boolean {
  const stillOurs = releaseOwnedVisibility(state, state.clashVisibilityOwned ?? null);
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
 * This is also why the visibility CHANNELS stay OUT of the clash slice's shared
 * `CLASH_FOCUS_RESET`: `clearClashFocus()` is ALSO called at RUN START
 * (`useClash.discardSolidPresentation`), where the release must be ownership-
 * aware for the same reason — #2662 P2. Adding them to that constant fails
 * `useClash.run-preserves-isolation.test.tsx` ("a user-established X-ray ghost
 * SURVIVES run()"), verified. The ownership RECORD is a different thing and IS
 * in that constant, which is what closes the stale-claim hole above.
 *
 * ## ORDER: release, THEN clear (load-bearing)
 *
 * Because `clashVisibilityOwned` is a member of `CLASH_FOCUS_RESET`, the clash
 * clear NULLS the record. So the release must run FIRST. Clearing first would
 * leave `releaseOwnedClashVisibility` reading `null`, finding nothing to
 * release, and leaving clash's own ghost or isolation standing over a scene
 * whose models just changed — the originally reported #2654 bug, reopened, with
 * every existing test still green. The same holds for `clashHighlightColors`,
 * which is why `clashPainted` is sampled first as well.
 *
 * `useClash.discardSolidPresentation` observes the same order for the same
 * reason: `releaseClashVisibility()` before `clearClashFocus()`.
 *
 * And the order is self-enforcing rather than merely documented: every step
 * calls `read()` afresh, so a reordering cannot hide behind a stale snapshot —
 * it fails 8 tests across three files instead (verified by mutation).
 *
 * @param read re-reads the store. A thunk, not a snapshot, and called at EVERY
 *   step: each step commits a new state object, and the callers also run other
 *   cross-slice clears (`clearMutations`, `clearMutationView`, `removeSourceTag`,
 *   and `resetViewerState`'s whole `set()`) before reaching here, so even the
 *   first read cannot be hoisted to the caller.
 */
export function endClashScenePresentation(
  read: () => ClashSceneTeardown,
  mode: 'model-removed' | 'federation-cleared',
): void {
  const wipeAll = mode === 'federation-cleared';

  // Every step below calls `read()` afresh rather than sharing one snapshot.
  // That is deliberate, and it is what makes the ORDER self-enforcing: under a
  // shared snapshot, moving the clash clear ahead of the release would still
  // "work", because the snapshot would keep handing the release a
  // `clashVisibilityOwned` the clear had already nulled. The bug would then be
  // one stale-read cleanup away from going live with every test green. Reading
  // fresh means a reordering breaks LOUDLY instead (8 tests across three files,
  // verified by mutation).

  // ── Step 1: sample the paint fact, BEFORE anything here mutates ──────────
  // `clashHighlightColors` is a member of `CLASH_FOCUS_RESET`; after step 2 it
  // reads `null` and the amber/cyan pair tint stays painted on the survivors.
  const clashPainted = read().clashHighlightColors != null;

  // ── Step 2: release the SHARED visibility channels ───────────────────────
  // Must precede step 3: `clashVisibilityOwned` is a member of
  // `CLASH_FOCUS_RESET` too, so the clash clear ends clash's claim. Released
  // afterwards, the predicate reads `null`, finds nothing to release, and
  // leaves clash's own ghost or isolation standing over a scene whose models
  // just changed — the originally reported #2654 bug.
  let released: boolean;
  if (wipeAll) {
    // Every model is gone: nothing survives for either channel to refer to, so
    // both go outright, ownership or not.
    const s = read();
    s.clearIsolation?.();
    s.clearGhost?.();
    s.setClashVisibilityOwned?.(null);
    released = true;
  } else {
    released = releaseOwnedClashVisibility(read());
  }

  // ── Step 3: end the clash slice's own focus ──────────────────────────────
  const s = read();
  if (wipeAll) s.clearClash?.();
  else s.clearClashFocus?.();

  // ── Step 4: hand the paint channel back to whoever owns it next ──────────
  const after = read();
  if (wipeAll) after.setPendingColorUpdates?.(new Map());
  else if (clashPainted || released) {
    after.setPendingColorUpdates?.(new Map(after.lensAppliedColors ?? []));
  }
}
