/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A "latest request wins" guard for an async operation kicked off from a
 * synchronous UI event that can fire again before the first call resolves —
 * the shape of race `focusClash`'s on-demand intersection-solid compute has
 * to defend against: clicking clash A then quickly clash B must not have A's
 * compute land AFTER B is focused and paint A's stale solid over B's pair.
 *
 * `begin()` must be called synchronously at the START of every new attempt,
 * and the async callback must capture the token it returns and check
 * `isCurrent(token)` before writing any result to shared state — a `false`
 * means a later `begin()` already ran. This module makes no claim about
 * *which* call sites do that; it is a generic, reusable primitive.
 * `useClash`'s actual solid-compute guard is `clashSolidRequestSeq`
 * (clashSlice.ts) instead of an instance of this class: that field is bumped
 * by `setClashSelectedId` and `clearClashSolid`, store actions every clash-
 * focus teardown path already calls, so any new teardown path invalidates the
 * in-flight compute automatically instead of needing to remember to call a
 * guard like this one (#2574 review: a prior version of this doc claimed
 * `begin()` ran on "every teardown/clear path" — two call sites,
 * `tours/clash.ts` and `store/homeView.ts`, reset the same focus fields by
 * hand and never reached the guard because it lived in a hook-private `useRef`).
 *
 * A plain zustand `set` cannot do this on its own: two `.then` callbacks
 * racing to call `set` in resolution order (not request order) is exactly the
 * bug this exists to prevent, and zustand has no built-in request identity.
 */
export interface LatestWinsGuard {
  /** Call synchronously when a new attempt starts (or an old one is torn
   *  down). Returns a token for that attempt. */
  begin(): number;
  /** True only if `token` is the most recent one `begin()` returned. */
  isCurrent(token: number): boolean;
}

export function createLatestWinsGuard(): LatestWinsGuard {
  let seq = 0;
  return {
    begin(): number {
      seq += 1;
      return seq;
    },
    isCurrent(token: number): boolean {
      return token === seq;
    },
  };
}
