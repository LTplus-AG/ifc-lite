/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Prospective registration parameters; no default existing runner is changed.
export const INPUT_WITNESS_BOUNDS = Object.freeze({
  deliveries: 10000, calls: 10000, retainedBytes: 256 * 1024 ** 2,
});

export function requireViewerInputIdentityPair(a, b) {
  const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  for (const row of [a, b]) {
    if (row?.protocol !== 'independent-viewer-input-v3-empty-accounting-instrumented' || row.complete !== true
      || !hex(row.producedSha256) || !hex(row.rawInstancedInputSha256) || !hex(row.viewportInputSha256)) {
      throw new Error('REFUSE: incomplete/unknown independent input identity');
    }
  }
  for (const field of ['producedSha256', 'viewportInputSha256']) {
    if (a[field] !== b[field]) throw new Error(`REFUSE: ${field} mismatch`);
  }
  // The existing protocol's runtime/readiness/resources/AA checks remain
  // separately mandatory. This helper does not grant timing eligibility.
  return { identityEqual: true, timingEligibility: 'requires full independent protocol gates' };
}
