/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who owns the shared visibility channels while an IDS RESULT ROW is focused
 * (#2867) — and the one release that reads that ownership.
 *
 * The per-row focus modes mirror the clash panel's (`lib/clash/visibility-
 * ownership.ts`, #1275 / #2654): `isolate` installs the row's element into
 * `isolatedEntities`, `ghost` installs it into `ghostExceptEntities`, and
 * `highlight` installs nothing and owns nothing. Both subsystems write the
 * SAME two channels, so both answer the ownership question with the same
 * predicate — `lib/visibility/ownership.ts` — rather than each carrying a copy
 * that can drift.
 *
 * ## Scope: the ROW focus, not IDS's set-level isolation
 *
 * IDS also has set-level isolation (`isolateFailed` / `isolatePassed` /
 * `isolateInvolved`), tracked separately by `idsIsolateMode` and driven by its
 * own buttons. This record covers ONLY what activating a single result row
 * installed. A row focus in `isolate` or `ghost` mode supersedes a set-level
 * isolation on screen — one presentation at a time, the same as clash — and
 * `useIDS.focusEntity` clears `idsIsolateMode` when it does, so the isolate
 * buttons do not keep showing a pressed state for an isolation the row focus
 * replaced.
 *
 * ## Why a store field and not a hook ref
 *
 * The same reason clash's moved (#2654 third review): store-level teardowns —
 * `removeModel`, `clearAllModels`, `resetViewerState`, and the IDS slice's own
 * report/document clears — must be able to read it. A `useIDS()`-private ref
 * is unreachable from all of them, and the alternative, inferring ownership
 * from `idsActiveEntityId`, is wrong in both directions: a `highlight` focus
 * sets an active entity while owning nothing (over-clear), and the record
 * outlives nothing at all if the row is deactivated without the channel being
 * released (under-clear).
 */

import {
  releaseOwnedVisibility,
  type VisibilityChannels,
  type VisibilityOwnership,
} from '../visibility/ownership.js';
import { IDS_FOCUS_COLOR } from '../../hooks/ids/idsColorSystem.js';

/**
 * What the IDS row focus last installed into a shared visibility channel, and
 * which one. `null` means the row focus owns neither channel — including after
 * a `highlight`-mode focus, which deliberately installs nothing.
 */
export type IDSFocusVisibilityOwnership = VisibilityOwnership;

/** The store surface `releaseOwnedIdsFocusVisibility` reads and writes. Every
 *  member is optional, for the same reason clash's is: slice-level tests drive
 *  store actions through harnesses that stub `get()` with a single slice. */
export interface IDSFocusVisibilityChannels extends VisibilityChannels {
  idsFocusVisibilityOwned?: IDSFocusVisibilityOwnership;
  setIdsFocusVisibilityOwned?: (owned: IDSFocusVisibilityOwnership) => void;
}

/**
 * Release the isolation/ghost the IDS row focus itself installed — and ONLY
 * that. A presentation established by clash, the spaces X-ray, "Isolate in 3D"
 * or IDS's own set-level isolate buttons does not content-match the record, so
 * it survives untouched.
 *
 * The record is dropped either way: once this has run, the row focus makes no
 * further claim. That is not optional tidiness — ownership is tested by VALUE,
 * so a record left behind after its presentation ended starts matching again
 * the moment another owner installs a set with equal content, and the next
 * release destroys THAT owner's presentation (#2654 fourth review).
 *
 * The drop matters most on the branch where nothing is released. When this DID
 * release through the live store, the store's own channel-write invalidation
 * (`store/visibility-invalidation.ts`) would have dropped the record for the
 * same reason — which is exactly why no store-driven test can see this line.
 * When the answer is "not ours", nothing is written, nothing invalidates, and
 * this is the only thing that ends the stale claim. `visibility-ownership.test.ts`
 * covers both branches over the all-optional surface this is typed for.
 *
 * @returns whether a channel was actually released — i.e. whether the row
 *   focus was still, verifiably, the owner.
 */
export function releaseOwnedIdsFocusVisibility(state: IDSFocusVisibilityChannels): boolean {
  const owned = state.idsFocusVisibilityOwned ?? null;
  // No record: nothing to release, and nothing to drop. Returning before the
  // write keeps this the pure no-op it reads as — an unconditional
  // `setIdsFocusVisibilityOwned(null)` would commit a fresh store state (and
  // notify every subscriber) on every ownership-free release path, and several
  // of them run on every model removal. Same shape as
  // `releaseOwnedClashVisibility`.
  if (!owned) return false;
  const stillOurs = releaseOwnedVisibility(state, owned);
  state.setIdsFocusVisibilityOwned?.(null);
  return stillOurs;
}

type ColorOverrides = Map<number, [number, number, number, number]>;

/** The store surface `endIdsRowFocusPresentation` reads and writes: the
 *  visibility channels above plus the PAINT channel (dataSlice). Optional for
 *  the same reason. */
export interface IDSRowFocusPresentation extends IDSFocusVisibilityChannels {
  pendingColorUpdates?: ColorOverrides | null;
  setPendingColorUpdates?: (updates: ColorOverrides) => void;
}

/**
 * End the WHOLE row-focus presentation — both channels it writes.
 *
 * The row focus is two channels, not one: the shared visibility channel
 * (`isolatedEntities` / `ghostExceptEntities`, released by ownership above)
 * and the PAINT channel — `focusEntity` repaints the activated element
 * {@link IDS_FOCUS_COLOR} through `pendingColorUpdates`, the albedo path, so
 * the row can be found among identically-red neighbours. #2867 released the
 * first at all eleven of its release sites and the second at none of them, so
 * a model removal or a cleared report left a cyan marker painted on an element
 * whose row no longer exists. `ClashPanel`'s unmount cleanup has always handed
 * the paint channel back for exactly this reason (#1277 review), and
 * `endClashScenePresentation` documents the same three-channel shape.
 *
 * What is released is the tint the row focus ITSELF added, not the overlay it
 * added it to. The focus colour is painted ON TOP of the report's red/green —
 * that surrounding context is what makes it mean anything — and the report
 * overlay belongs to the report, which these paths do not all invalidate. So
 * the entries wearing the focus colour are dropped and every other entry is
 * left exactly as it was. That is the same value-identity discipline the
 * visibility channels use, with the same single, bounded false positive: an
 * entry another owner painted this precise RGBA is indistinguishable from the
 * marker and goes with it.
 *
 * `useIDS`'s own release sites do NOT come through here — `clearEntitySelection`
 * and `applyFocusMode` follow their release with `paintFocus()`, which rebuilds
 * the report overlay in full (the display options and geometry that needs are
 * the hook's, not the store's). This is for the store- and panel-level
 * teardowns, which have no way to rebuild it and must not leave the marker.
 *
 * @returns whether the visibility channel was actually released — i.e. whether
 *   the row focus was still, verifiably, its owner.
 */
export function endIdsRowFocusPresentation(state: IDSRowFocusPresentation): boolean {
  const released = releaseOwnedIdsFocusVisibility(state);

  const painted = state.pendingColorUpdates;
  if (painted) {
    let marked = false;
    const next: ColorOverrides = new Map();
    for (const [id, color] of painted) {
      if (isFocusColor(color)) { marked = true; continue; }
      next.set(id, color);
    }
    // Only write when something changes: an unconditional push would commit a
    // new map — and re-run the fire-and-forget override effect — on every model
    // removal in a session that never focused an IDS row.
    if (marked) state.setPendingColorUpdates?.(next);
  }

  return released;
}

function isFocusColor(color: readonly number[]): boolean {
  return color.length === IDS_FOCUS_COLOR.length
    && color.every((c, i) => c === IDS_FOCUS_COLOR[i]);
}
