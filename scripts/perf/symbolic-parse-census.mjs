/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Passive page.evaluate callback for #6537. This observer does not parse,
 * render, request a frame, change toggles, intercept writes, or qualify GPU inputs.
 * Kept separate from the timed comparator and authored-text identity guard. */
export function readSymbolicParseOutcomeCensus() {
  const state = globalThis.__ifc_lite_viewer_store__?.getState();
  if (typeof state?.readSymbolicParseOutcomes !== 'function') {
    return { schema: 'symbolic-parse-outcomes-v1', status: 'refused', reason: 'observer-unavailable' };
  }
  return state.readSymbolicParseOutcomes();
}
