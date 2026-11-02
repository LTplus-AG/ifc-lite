/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** No ready variant until the native shared-composition contract is qualified. */
export type GaussianReadiness =
  | { state: 'initializing' | 'lost' | 'disposed'; generation: number }
  | { state: 'blocked'; generation: number; reasons: readonly string[] };

const blockers = Object.freeze([
  'exact-mixed-transparency', 'scalable-global-order', 'native-viewer-contract',
]);

/** Uses the renderer's existing lifetime; no second device or readiness latch. */
export function gaussianReadiness(ready: boolean, lost: boolean, disposed: boolean, generation: number): GaussianReadiness {
  if (disposed) return { state: 'disposed', generation };
  if (lost) return { state: 'lost', generation };
  if (!ready) return { state: 'initializing', generation };
  return { state: 'blocked', generation, reasons: blockers };
}
