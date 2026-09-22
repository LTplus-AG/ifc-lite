/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Event-loop plumbing for the chunked federated evaluator (`filter-evaluate.ts`). */

export function throwAbort(signal: AbortSignal): never {
  // Match the shape DOM throws on AbortController.signal.aborted reads —
  // callers can `instanceof DOMException && err.name === 'AbortError'`.
  throw new DOMException(
    signal.reason instanceof Error ? signal.reason.message : 'evaluateFilterRules aborted',
    'AbortError',
  );
}

/** Yield control to the event loop. Mirrors `tier1-index.ts` so we
 *  don't pin the Node test runner — `scheduler.yield` (browsers /
 *  Node 22+) and `setImmediate` (Node fallback) are preferred over
 *  the MessageChannel trick because the latter requires explicit
 *  port closure to release the loop reference. */
export function yieldToEventLoop(): Promise<void> {
  const maybeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof maybeScheduler?.yield === 'function') return maybeScheduler.yield();
  if (typeof setImmediate === 'function') {
    return new Promise<void>((resolve) => { setImmediate(() => resolve()); });
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
