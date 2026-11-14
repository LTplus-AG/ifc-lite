/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "The user just asked for a model": a pick, a drop, the Open button, a model
 * URL. Set synchronously by the entry point, before the WebGPU check, bundle
 * preparation or the picker can await, so start-screen work scheduled for
 * idle time can stand down before the store's `loading` flips. That gap is
 * a few milliseconds for a picked IFC file (3.6-12.4 ms change -> load start
 * on the scoreboard host) but whole seconds while a picker is open, the
 * WebGPU check is still pending, or a drop's file handles resolve.
 */

let lastAt = Number.NEGATIVE_INFINITY;
const listeners = new Set<() => void>();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Record a load intent now and tell every subscriber. */
export function markLoadIntent(): void {
  lastAt = now();
  for (const listener of [...listeners]) listener();
}

/** Milliseconds since the last load intent (Infinity when there was none). */
export function msSinceLoadIntent(): number {
  return now() - lastAt;
}

export function subscribeLoadIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests only: forget the last intent. */
export function resetLoadIntentForTests(): void {
  lastAt = Number.NEGATIVE_INFINITY;
}
