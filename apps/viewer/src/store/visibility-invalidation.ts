/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place `isolatedEntities` / `ghostExceptEntities` can be written —
 * the store's own `set`.
 *
 * ## Why this is a middleware and not a helper
 *
 * These two channels are shared by clash, IDS, "Isolate in 3D", assembly
 * isolation, `LayerDiffView`, Space Sketch, BCF, the basket and
 * `syncSourceModel`. Each feature records what it installed so its teardown
 * can release only that, and ownership is tested by VALUE — so a record left
 * behind after ANOTHER owner replaced the channel is not inert: it goes
 * matching → cleared → MATCHING AGAIN the moment a third owner installs a set
 * with equal content, at which point the stale owner's next release destroys
 * that owner's presentation (#2654 fourth review).
 *
 * Review of #2867 answered that in `visibilitySlice`'s named setters. A list
 * of writers is not an invariant: the same file's `showAllInAllModels` wrote
 * both channels through a bare `set()` and was already off the list the day it
 * was written, and `pinboardSlice` — a different slice — writes
 * `isolatedEntities` from ten of its actions, every one of them stranding
 * records.
 * Wrapping `set` itself removes the choice. A slice cannot reach these fields
 * except through the store's `set`, and `useViewerStore.setState` is the same
 * wrapped function, so a writer added in any slice, or a direct `setState`
 * from a hook or a test, is covered without being told to be.
 *
 * ## What it does, and what it deliberately does not do
 *
 * Invalidation is by CONTENT, not by "somebody wrote": `staleOwnershipReset`
 * is given the channel state the write is about to commit, and a record still
 * content-matching it survives. That is what keeps the content-preserving
 * replays alive — Space Sketch's open/close view capture and
 * `syncSourceModel`'s rebuild both push an unchanged channel back through
 * `set`, and under a blanket "any write invalidates" rule they would silently
 * convert a feature-owned focus into "user" state, which is #2662 P2 again.
 *
 * A record field the patch ITSELF carries is left exactly as the patch has it.
 * An installer committing the channel and its claim in one `set()` is stating
 * both at once and must not have the claim eaten by the write that created it.
 * (Today's installers write the channel first and the record second, two
 * `set()`s — this makes the atomic form safe too rather than a latent trap.)
 *
 * A patch touching NEITHER channel is returned by reference, so the common
 * case adds no keys, allocates nothing, and preserves the identity-return
 * optimisation slices use to skip subscriber notifications
 * (`setHasTypeGeometry`).
 */

import type { StateCreator, StoreMutatorIdentifier } from 'zustand';
import {
  staleOwnershipReset,
  type OwnedVisibilityRecords,
  type VisibilityChannels,
} from '../lib/visibility/ownership.js';

/** The state surface this middleware reads: the two shared channels plus every
 *  ownership record over them. */
type ChannelState = Pick<VisibilityChannels, 'isolatedEntities' | 'ghostExceptEntities'> &
  OwnedVisibilityRecords;

type SetState<T> = (
  partial: T | Partial<T> | ((state: T) => T | Partial<T>),
  replace?: boolean | undefined,
) => void;

/**
 * Wrap a state creator so every write that replaces a shared visibility
 * channel also drops the ownership records that write makes stale.
 */
export function withVisibilityOwnershipInvalidation<
  T extends ChannelState,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(creator: StateCreator<T, Mps, Mcs>): StateCreator<T, Mps, Mcs> {
  return ((set, get, api) => {
    const guardedSet: SetState<T> = (partial, replace) => {
      (set as SetState<T>)((state: T) => {
        const patch = typeof partial === 'function'
          ? (partial as (s: T) => T | Partial<T>)(state)
          : partial;
        return applyOwnershipInvalidation(state, patch);
      }, replace);
    };

    // Replace the store API's own setter too, not just the one handed to the
    // slices: `useViewerStore.setState(...)` is that function, and it is a
    // first-class writer of these channels (BCF viewpoint application, the
    // collab room, test harnesses). Leaving it unwrapped would reintroduce the
    // bypass this middleware exists to close.
    api.setState = guardedSet as typeof api.setState;

    return creator(guardedSet as typeof set, get, api);
  }) as StateCreator<T, Mps, Mcs>;
}

/**
 * The invalidation itself, separated from the middleware plumbing so it can be
 * exercised directly.
 *
 * @returns `patch` by reference when nothing went stale.
 */
export function applyOwnershipInvalidation<T extends ChannelState>(
  state: T,
  patch: T | Partial<T>,
): T | Partial<T> {
  if (!patch || typeof patch !== 'object') return patch;

  const writesIsolate = 'isolatedEntities' in patch;
  const writesGhost = 'ghostExceptEntities' in patch;
  if (!writesIsolate && !writesGhost) return patch;

  // The channel state the write is about to leave behind: what the patch sets,
  // and for the channel it does not touch, what is already there.
  const next = {
    isolatedEntities: writesIsolate ? patch.isolatedEntities ?? null : state.isolatedEntities ?? null,
    ghostExceptEntities: writesGhost ? patch.ghostExceptEntities ?? null : state.ghostExceptEntities ?? null,
  };

  const reset = staleOwnershipReset(state, next);
  let stale = false;
  for (const field of Object.keys(reset) as (keyof OwnedVisibilityRecords)[]) {
    // The patch states this record itself — that is the writer's own claim
    // about the state it is committing, not a leftover from an earlier one.
    if (field in patch) delete reset[field];
    else stale = true;
  }
  if (!stale) return patch;

  return { ...patch, ...reset };
}
