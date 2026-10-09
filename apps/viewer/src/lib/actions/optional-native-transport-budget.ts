/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7360: optional complete graph pins share an allowance across a selection.
 * Ordinary identity/property rows keep the existing envelope budget. Never
 * shorten expected records: refuse a whole pin with explicit unknown coverage.
 */
export function optionalNativeTransportBudget() {
  let remaining = 12_000;
  return <T>(pin: T): T | { status: 'unavailable-transport-budget'; recordCount: null; expectedJsonParts: null } => {
    // Count escaped JSON too: selection evidence may be embedded in a prompt.
    const cost = JSON.stringify(JSON.stringify(pin)).length;
    if (cost > remaining) return { status: 'unavailable-transport-budget', recordCount: null, expectedJsonParts: null };
    remaining -= cost;
    return pin;
  };
}
