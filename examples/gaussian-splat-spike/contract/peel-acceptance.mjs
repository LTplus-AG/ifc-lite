/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

/**
 * Compares two RGBA8 images (1x pixels or unpacked per-sample texels). In the
 * peel scene only red Gaussians write red: glass, opaque and blue splats have R = 0.
 */
export function comparePeelImages(reference, candidate) {
  assert.equal(candidate.length, reference.length, 'reference and candidate image sizes differ');
  let referenceSplatTexels = 0, candidateSplatTexels = 0, differentChannels = 0, differentTexels = 0;
  for (let i = 0; i < reference.length; i += 4) {
    if (reference[i] > 0) referenceSplatTexels++;
    if (candidate[i] > 0) candidateSplatTexels++;
    let differs = false;
    for (let channel = i; channel < i + 4; channel++) {
      if (reference[channel] !== candidate[channel]) { differentChannels++; differs = true; }
    }
    if (differs) differentTexels++;
  }
  return { referenceSplatTexels, candidateSplatTexels, differentChannels, differentTexels };
}

/**
 * Acceptance for one presented frame: both images carry red splat contribution,
 * the candidate explicitly reports that peeling was not exhausted, and every
 * channel equals the independent reference. An exhausted frame is rejected even
 * when its pixels match, so truncation can never pass as success.
 */
export function assertPeelAccepted(row) {
  assert.ok(row.referenceSplatTexels > 0, 'reference must contain red splat contribution');
  assert.ok(row.candidateSplatTexels > 0, 'candidate must contain red splat contribution');
  assert.equal(typeof row.exhaustion?.reported, 'boolean', 'candidate must report peel exhaustion explicitly');
  assert.equal(row.exhaustion.reported, false, 'exhausted peel frame must be rejected, never presented');
  assert.equal(row.differentChannels, 0, 'candidate must exactly match independent reference');
}

/** Returns the predicate's rejection message, or null when the row is accepted. */
export function peelRejection(row) {
  try {
    assertPeelAccepted(row);
    return null;
  } catch (error) {
    if (error instanceof assert.AssertionError) return error.message.split('\n')[0];
    throw error;
  }
}
