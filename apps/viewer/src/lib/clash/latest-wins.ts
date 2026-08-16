/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A "latest request wins" guard for an async operation kicked off from a
 * synchronous UI event that can fire again before the first call resolves —
 * exactly `focusClash`'s on-demand intersection-solid compute: clicking clash
 * A then quickly clash B must not have A's compute land AFTER B is focused and
 * paint A's stale solid over B's pair. There is no other signal in the store
 * that a request was superseded (the store doesn't know which JS closure is
 * "the current one"), so this token is the only thing that can tell.
 *
 * `begin()` is called synchronously at the START of every attempt (including
 * every teardown/clear path, which calls it and discards the token — it only
 * needs to invalidate whatever came before). The async callback captures the
 * token `begin()` returned and must check `isCurrent(token)` before writing
 * any result to shared state; a `false` means a later `begin()` already ran.
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
