/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Disable React 19.2's DEV-mode component-render Performance tracking.
 *
 * react-dom (dev build) calls `logComponentRender` on every commit whose props
 * changed; it recursively walks the prop diff (`addObjectDiffToProperties` →
 * `addObjectToProperties`, a `for..in` recursion with no depth/size bound) to feed
 * the browser's Performance timeline. The viewer passes large IFC `geometryResult`
 * (typed arrays — `for..in` enumerates every index across thousands of meshes) and
 * the `ifcDataStore` (circular relationship-graph refs → unbounded recursion) as
 * props, so on big models (schependomlaan, Holter Tower) the diff array grows until
 * `RangeError: Invalid array length` and a multi-GB main-thread OOM — the load
 * "stops halfway" and the tab stalls/crashes. (Playwright-confirmed: with this
 * tracker off, Holter loads in ~350MB instead of OOMing at ~4GB.)
 *
 * React gates the entire tracker on `supportsUserTiming`, cached at react-dom init
 * from `typeof performance.measure === 'function'`. Making `performance.measure`
 * unavailable BEFORE react-dom initializes (this is the first import in main.tsx)
 * disables ONLY this tracking; the viewer times with `performance.now()`, not
 * `measure`. DEV-only — the production build strips the tracker, so this is a no-op.
 */
if (import.meta.env.DEV && typeof performance !== 'undefined') {
  try {
    (performance as unknown as { measure?: unknown }).measure = undefined;
  } catch (err) {
    // `performance.measure` is read-only in some engines — surface it so a
    // failed patch (which leaves large models OOM-prone) isn't silently hidden.
    if (typeof console !== 'undefined') {
      console.warn(
        '[perf-track] could not disable React DEV perf tracking; large models may OOM',
        err,
      );
    }
  }
}
