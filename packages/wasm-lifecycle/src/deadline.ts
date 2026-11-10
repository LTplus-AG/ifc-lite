/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One deadline timer for worker start and request timeouts (`createWorkerRpc`).
 *
 * `setTimeout` treats a delay above 2^31-1 ms (and `Infinity`) as 1 ms, so a
 * caller asking for "very long" would get "immediately". The timeout options
 * therefore read as:
 * - a positive finite number: that many ms, clamped to 2^31-1 (~24.8 days);
 * - `0`, a negative number, `NaN` or `Infinity`: no deadline at all.
 */

/** Largest delay `setTimeout` honours (signed 32-bit ms). */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** The delay to arm for `ms`, or `null` when `ms` means "no deadline". */
export function deadlineDelay(ms: number): number | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, MAX_TIMER_DELAY_MS);
}

/** Run `onExpire` after `ms` (see `deadlineDelay`); returns the cancel. */
export function armDeadline(ms: number, onExpire: () => void): () => void {
  const delay = deadlineDelay(ms);
  if (delay === null) return () => {};
  const timer = setTimeout(onExpire, delay);
  return () => clearTimeout(timer);
}
