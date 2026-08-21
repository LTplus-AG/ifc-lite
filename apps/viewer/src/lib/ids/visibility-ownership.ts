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
 * @returns whether a channel was actually released — i.e. whether the row
 *   focus was still, verifiably, the owner.
 */
export function releaseOwnedIdsFocusVisibility(state: IDSFocusVisibilityChannels): boolean {
  const stillOurs = releaseOwnedVisibility(state, state.idsFocusVisibilityOwned ?? null);
  state.setIdsFocusVisibilityOwned?.(null);
  return stillOurs;
}
