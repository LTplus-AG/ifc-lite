/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

export function compareIntervalPixels(reference, candidate) {
  assert.equal(candidate.length, reference.length);
  // This scene has red splats and green glass on black: only splats write red.
  const redPixels = pixels => pixels.filter((value, i) => i % 4 === 0 && value > 0).length;
  return {
    referenceSplatPixels: redPixels(reference),
    candidateSplatPixels: redPixels(candidate),
    differentChannels: candidate.reduce((n, value, i) => n + (value !== reference[i] ? 1 : 0), 0),
  };
}

export function assertIntervalAccepted(row) {
  assert.ok(row.referenceSplatPixels > 0, 'reference must contain red splat contribution');
  assert.ok(row.candidateSplatPixels > 0, 'candidate must contain red splat contribution');
  assert.equal(row.differentChannels, 0, 'candidate must exactly match independent reference');
}
