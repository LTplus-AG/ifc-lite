/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The basket's relationship to the shared `isolatedEntities` channel — pure
 * helpers for `pinboardSlice.ts` (#4527).
 *
 * `isolatedEntities` is one `Set<number> | null` written by several owners
 * (basket, direct isolate, BCF viewpoint restore, lens, search). The basket API
 * is incremental: `addToBasket` widens whatever is isolated and
 * `removeFromBasket` narrows it — so it must know which ids IT put there. That
 * record is `BasketIsolationOwnership`, the basket's instance of the repo-wide
 * ownership convention in `lib/visibility/ownership.ts`:
 *
 *  - `ids`    the channel content as the basket last wrote it. Ownership is
 *             judged BY VALUE (`ownsCurrentVisibility`): if another writer has
 *             since replaced the channel, the basket no longer owns it and its
 *             claims are void — the invalidation middleware
 *             (`store/visibility-invalidation.ts`) nulls the record on such a
 *             write, and every helper here re-checks before trusting it.
 *  - `claims` the ids the basket itself inserted (absent from the channel when
 *             pinned). An id that was already isolated by someone else when it
 *             was pinned is NOT claimed, so unpinning it leaves it isolated.
 *  - `seeded` whether the basket turned `null` into a Set — i.e. opened the
 *             isolation channel and may close it again when it empties. Not
 *             derivable from `claims`: a basket added onto a restored
 *             empty-but-active isolate (#4509) claims everything yet did not
 *             open the channel.
 */

import type { EntityRef } from '../types.js';
import { entityRefToString, stringToEntityRef } from '../types.js';
import { toGlobalIdForRef } from '../globalId.js';
import { ownsCurrentVisibility, type VisibilityChannels } from '../../lib/visibility/ownership.js';

export type BasketIsolationOwnership =
  | { channel: 'isolate'; ids: ReadonlySet<number>; claims: ReadonlySet<number>; seeded: boolean }
  | null;

type Models = Map<string, { idOffset: number }>;

/** Convert basket EntityRefs to global IDs using model offsets */
export function basketToGlobalIds(basketEntities: Set<string>, models: Models): Set<number> {
  const globalIds = new Set<number>();
  for (const str of basketEntities) {
    globalIds.add(toGlobalIdForRef(models, stringToEntityRef(str)));
  }
  return globalIds;
}

/** Compute a single EntityRef's global ID */
export function refToGlobalId(ref: EntityRef, models: Models): number {
  return toGlobalIdForRef(models, ref);
}

export function refsToEntityKeySet(refs: EntityRef[]): Set<string> {
  const keys = new Set<string>();
  for (const ref of refs) keys.add(entityRefToString(ref));
  return keys;
}

export function entityKeysToRefs(keys: Iterable<string>): EntityRef[] {
  return [...keys].map(stringToEntityRef);
}

/** The record for a channel the basket wrote wholesale: it owns every id. */
export function ownedWholesale(isolated: Set<number> | null): BasketIsolationOwnership {
  return isolated === null ? null : { channel: 'isolate', ids: new Set(isolated), claims: new Set(isolated), seeded: true };
}

/**
 * Wholesale basket → visibility (`setBasket`, view restore, `showPinboard`):
 * the channel becomes exactly the basket's ids, and the basket owns all of it.
 */
export function computeBasketVisibility(
  nextBasket: Set<string>,
  models: Models,
  currentHidden: Set<number>,
  unhideRefs?: EntityRef[],
): { isolatedEntities: Set<number> | null; hiddenEntities: Set<number>; basketIsolationOwned: BasketIsolationOwnership } {
  if (nextBasket.size === 0) {
    return { isolatedEntities: null, hiddenEntities: currentHidden, basketIsolationOwned: null };
  }
  const isolatedEntities = basketToGlobalIds(nextBasket, models);
  const basketIsolationOwned = ownedWholesale(isolatedEntities);
  if (!unhideRefs || unhideRefs.length === 0) {
    return { isolatedEntities, hiddenEntities: currentHidden, basketIsolationOwned };
  }
  const hiddenEntities = new Set<number>(currentHidden);
  for (const ref of unhideRefs) hiddenEntities.delete(toGlobalIdForRef(models, ref));
  return { isolatedEntities, hiddenEntities, basketIsolationOwned };
}

interface IsolationState extends VisibilityChannels {
  isolatedEntities: Set<number> | null;
  hiddenEntities: Set<number>;
  models: Models;
  basketIsolationOwned: BasketIsolationOwnership;
}

/** The basket's record, but only if the channel still holds what the basket wrote. */
function liveRecord(state: IsolationState): Exclude<BasketIsolationOwnership, null> | null {
  const owned = state.basketIsolationOwned;
  return owned && ownsCurrentVisibility(state, owned) ? owned : null;
}

/**
 * `addToBasket`: widen the isolation with the pinned refs' ids, claiming only
 * the ones that were not isolated already; open the channel when it was null.
 */
export function basketAddIsolation(
  state: IsolationState,
  nextBasket: Set<string>,
  refs: EntityRef[],
): { isolatedEntities: Set<number>; hiddenEntities: Set<number>; basketIsolationOwned: BasketIsolationOwnership } {
  const hiddenEntities = new Set<number>(state.hiddenEntities);
  const prev = state.isolatedEntities;
  let isolatedEntities: Set<number>;
  let claims: Set<number>;
  let seeded: boolean;
  if (prev === null) {
    // The basket opens the channel: everything in it is the basket's.
    isolatedEntities = basketToGlobalIds(nextBasket, state.models);
    claims = new Set(isolatedEntities);
    seeded = true;
  } else {
    const live = liveRecord(state);
    isolatedEntities = new Set(prev);
    claims = new Set(live?.claims ?? []);
    seeded = live?.seeded ?? false;
    for (const ref of refs) {
      const gid = refToGlobalId(ref, state.models);
      if (!isolatedEntities.has(gid)) {
        isolatedEntities.add(gid);
        claims.add(gid);
      }
    }
  }
  for (const ref of refs) hiddenEntities.delete(refToGlobalId(ref, state.models));
  return {
    isolatedEntities,
    hiddenEntities,
    basketIsolationOwned: { channel: 'isolate', ids: new Set(isolatedEntities), claims, seeded },
  };
}

/**
 * `removeFromBasket`: narrow the isolation by the removed refs' ids — only the
 * ids the basket claimed and no surviving basket entry still needs. A channel
 * the basket does not own (replaced by another writer) is left untouched; a
 * channel the basket opened is closed again when the basket empties.
 */
export function basketRemoveIsolation(
  state: IsolationState,
  nextBasket: Set<string>,
  removed: EntityRef[],
): { isolatedEntities?: Set<number> | null; basketIsolationOwned: BasketIsolationOwnership } {
  const prev = state.isolatedEntities;
  if (nextBasket.size === 0) {
    if (prev === null) return { basketIsolationOwned: null };
    const live = liveRecord(state);
    if (!live) return { basketIsolationOwned: null }; // someone else's isolation: leave it
    if (live.seeded) return { isolatedEntities: null, basketIsolationOwned: null };
    // The basket widened an isolation it did not open: give back the remainder
    // (possibly an empty, still-active Set — a valid state, see #4509).
    const remainder = new Set(prev);
    for (const id of live.claims) remainder.delete(id);
    return { isolatedEntities: remainder, basketIsolationOwned: null };
  }
  if (prev === null) {
    // The channel was cleared externally while the basket was non-empty
    // ("hide active basket"): the surviving basket re-takes it wholesale.
    const isolatedEntities = basketToGlobalIds(nextBasket, state.models);
    return { isolatedEntities, basketIsolationOwned: ownedWholesale(isolatedEntities) };
  }
  const live = liveRecord(state);
  if (!live) return { basketIsolationOwned: null }; // replaced by another writer: not ours to narrow
  const surviving = basketToGlobalIds(nextBasket, state.models);
  const isolatedEntities = new Set(prev);
  const claims = new Set(live.claims);
  for (const ref of removed) {
    const gid = refToGlobalId(ref, state.models);
    // Two refs can alias one global id (`toGlobalIdForRef` falls back to the raw
    // expressId for unregistered models), so an id a surviving entry still
    // derives stays; so does an id the basket never claimed.
    if (surviving.has(gid) || !claims.has(gid)) continue;
    isolatedEntities.delete(gid);
    claims.delete(gid);
  }
  return {
    isolatedEntities,
    basketIsolationOwned: { channel: 'isolate', ids: new Set(isolatedEntities), claims, seeded: live.seeded },
  };
}
