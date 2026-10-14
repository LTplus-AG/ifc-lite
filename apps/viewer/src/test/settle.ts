/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Waiting on async work without a wall-clock budget.
 *
 * A fixed sleep (`setTimeout(r, 50)`, 40 x 5 ms) bounds the work by wall
 * time: it passes when the file runs alone and fails once the runner shares
 * its CPU, and a NEGATIVE assertion behind it ("X did not happen") passes
 * vacuously, because X simply has not happened yet. Two clocks do not stretch
 * with load:
 *
 * - a condition (`waitUntil`), for work whose end can be observed;
 * - event-loop turns (`settle`), for work that cannot. Timers, `setImmediate`,
 *   fake-indexeddb, happy-dom's `requestAnimationFrame` and React's scheduler
 *   each advance one hop per turn however slow the machine is, so N turns
 *   bound a chain of fewer than N hops. `crypto.subtle.digest` is the
 *   exception: it runs on libuv's thread pool, so a file that hashes calls
 *   `trackDigests()` and turns spent while a digest is in flight do not count.
 *
 * Both take a deadline that is only a safety net for work that never ends; it
 * throws `message`, so a regression fails by name rather than at whichever
 * assertion reads the state next. Neither wraps `act`: React callers do.
 */

let digestsInFlight = 0;

/** Count in-flight `crypto.subtle.digest` calls; returns the restore. */
export function trackDigests(): () => void {
  const subtle = globalThis.crypto.subtle;
  const real = subtle.digest.bind(subtle);
  Object.defineProperty(subtle, 'digest', {
    configurable: true,
    writable: true,
    value: (...args: Parameters<SubtleCrypto['digest']>) => {
      digestsInFlight++;
      return real(...args).finally(() => { digestsInFlight--; });
    },
  });
  return () => { Reflect.deleteProperty(subtle, 'digest'); };
}

/** Poll `done()` every few ms until it holds; throw `message` past the deadline. */
export async function waitUntil(done: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`waitUntil: gave up after ${timeoutMs} ms: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Resolve once `ready()` holds and `turns` consecutive event-loop turns then
 * pass with no tracked digest in flight: every turn-bound chain of fewer hops
 * that was running has finished, however loaded the machine is.
 */
export async function settle(
  message: string,
  { ready = () => true, turns = 40, timeoutMs = 15_000 }: { ready?: () => boolean; turns?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  while (quiet < turns) {
    if (Date.now() > deadline) throw new Error(`settle: gave up after ${timeoutMs} ms: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    quiet = ready() && digestsInFlight === 0 ? quiet + 1 : 0;
  }
}
