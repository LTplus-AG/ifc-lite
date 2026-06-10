/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Yield control back to the event loop between parse chunks.
 *
 * Prefers the standard `scheduler.yield()` where available; otherwise
 * falls back to a MessageChannel round-trip (faster than `setTimeout(0)`
 * and available in both browsers and Node).
 */
export function yieldToEventLoop(): Promise<void> {
  const maybeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof maybeScheduler?.yield === 'function') {
    return maybeScheduler.yield();
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      // Close both ports — an open MessagePort holds a libuv handle in
      // Node, so leaking one per yield kept the process alive forever
      // after parsing large files (the CLI printed results but never
      // exited).
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
