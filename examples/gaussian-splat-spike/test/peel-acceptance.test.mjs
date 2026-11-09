/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPeelAccepted, comparePeelImages, peelRejection } from '../contract/peel-acceptance.mjs';

// #8564 K-layer peel: only red Gaussians write red in the witness scene.
const red = [120, 64, 30, 255], glass = [0, 128, 90, 255], darker = [119, 64, 30, 255];
const row = (reference, candidate, exhaustion = { reported: false }) => ({ ...comparePeelImages(reference, candidate), exhaustion });

test('identical glass-only images fail positive acceptance (#8616)', () => {
  const verdict = row(glass, glass);
  assert.equal(verdict.differentChannels, 0);
  assert.match(peelRejection(verdict), /reference must contain red/);
});

test('each image independently requires red splat contribution', () => {
  assert.match(peelRejection(row([...red, ...glass], [...glass, ...glass])), /candidate must contain red/);
  assert.match(peelRejection(row([...glass, ...glass], [...red, ...glass])), /reference must contain red/);
});

test('an exhausted frame is rejected even when its pixels match', () => {
  const verdict = row([...red, ...glass], [...red, ...glass], { reported: true, occlusionCount: 7 });
  assert.equal(verdict.differentChannels, 0);
  assert.throws(() => assertPeelAccepted(verdict), /exhausted peel frame must be rejected/);
});

test('a frame without an explicit exhaustion report is rejected', () => {
  const unreported = comparePeelImages([...red, ...glass], [...red, ...glass]);
  assert.match(peelRejection(unreported), /report peel exhaustion explicitly/);
  assert.match(peelRejection(row([...red, ...glass], [...red, ...glass], { reported: 0 })), /report peel exhaustion explicitly/);
});

test('a truncated image with a suppressed report fails on pixels', () => {
  const verdict = row([...red, ...glass], [...darker, ...glass]);
  assert.deepEqual([verdict.differentChannels, verdict.differentTexels], [1, 1]);
  assert.match(peelRejection(verdict), /exactly match/);
});

test('an exact non-exhausted match with red in both images is accepted', () => {
  const verdict = row([...glass, ...red], [...glass, ...red]);
  assert.deepEqual([verdict.referenceSplatTexels, verdict.candidateSplatTexels], [1, 1]);
  assert.equal(peelRejection(verdict), null);
  assert.throws(() => comparePeelImages([...red], [...red, ...red]), /sizes differ/);
});
