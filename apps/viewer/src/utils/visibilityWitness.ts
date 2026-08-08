/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Was this tab ever hidden while X was running?"
 *
 * Load timings are wall-clock, so a load that spans a tab switch reports the
 * user's absence as if it were work: browsers stop servicing
 * `requestAnimationFrame` and throttle timers in a hidden document. Field data
 * for `ifc_model_loaded` contains a 25-hour "load" for exactly that reason, and
 * a regression alert reading that metric is partly reading tab-switching
 * behaviour. Stamping each load with this flag lets the query exclude those
 * rows on evidence instead of on a magic duration threshold. (#2385)
 *
 * The listener is installed ONCE at module scope and never removed, so there is
 * no per-load subscribe/unsubscribe lifecycle that an early return or a throw
 * could leak. Callers take a cheap snapshot instead.
 */

let hiddenTransitions = 0;
let installed = false;

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenTransitions += 1;
  });
}

/**
 * Snapshot visibility now; the returned predicate answers whether the document
 * has been hidden at any point since — including the case where it was
 * *already* hidden when the snapshot was taken (a load started in a background
 * tab fires no transition at all).
 */
export function visibilityWitness(): () => boolean {
  ensureInstalled();
  const startedHidden =
    typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const at = hiddenTransitions;
  return () => startedHidden || hiddenTransitions > at;
}

/** Test seam: reset the module state between cases. */
export function __resetVisibilityWitnessForTest(): void {
  hiddenTransitions = 0;
  installed = false;
}
