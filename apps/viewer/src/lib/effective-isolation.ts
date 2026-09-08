/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which isolation set is actually in force.
 *
 * `computedIsolatedIds` (ViewportContainer) is the intersection of storey
 * isolation, the class filter and the store's `isolatedEntities`; it is `null`
 * when no isolation channel is active at all. The store's `isolatedEntities` is
 * the fallback for callers that render before that memo exists.
 *
 * Trivial on its own, but it is the value the renderer receives as
 * `isolatedIds`, so anything that has to agree with what the viewport draws —
 * the Cesium world view (#2578) — must resolve it the same way rather than
 * pick one of the two inputs and drift.
 */
export function effectiveIsolatedIds<
  TComputed extends ReadonlySet<number>,
  TStore extends ReadonlySet<number>,
>(
  computedIsolatedIds: TComputed | null | undefined,
  storeIsolatedEntities: TStore | null | undefined,
): TComputed | TStore | null {
  // Generic so the caller's set type survives: Viewport hands the result to a
  // ref typed `Set<number> | null`, while the Cesium overlay only reads it.
  return computedIsolatedIds ?? storeIsolatedEntities ?? null;
}
