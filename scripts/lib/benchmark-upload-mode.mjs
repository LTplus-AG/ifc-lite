/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Count cohorts exercise different fragment grouping and cannot qualify latency. */
export function requireTimingUploads(payload) {
  const mode = payload?.environment?.uploadMode ?? payload?.loadCounters?.uploadMode ?? 'timed';
  if (mode !== 'timed') {
    throw new Error(`GPU upload mode ${String(mode)} is not a timing workload; use count results only for structural comparisons.`);
  }
}
