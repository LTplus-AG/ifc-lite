/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareIntervalPixels, assertIntervalAccepted } from '../contract/fragment-interval-acceptance.mjs';

// #8616: fullscreen green glass must not qualify an absent splat renderer.
test('equal glass-only images fail positive interval acceptance', () => {
  const glass = [0, 128, 0, 255];
  const row = compareIntervalPixels(glass, glass);
  assert.equal(row.differentChannels, 0);
  assert.throws(() => assertIntervalAccepted(row), /reference must contain red/);
});
test('each image independently requires splat contribution', () => {
  const splat = [80, 128, 0, 255], glass = [0, 128, 0, 255];
  assert.throws(() => assertIntervalAccepted(compareIntervalPixels(splat, glass)), /candidate must contain red/);
  assert.throws(() => assertIntervalAccepted(compareIntervalPixels(glass, splat)), /reference must contain red/);
  assertIntervalAccepted(compareIntervalPixels(splat, splat));
  assert.throws(() => assertIntervalAccepted(compareIntervalPixels(splat, [81, 128, 0, 255])), /exactly match/);
});
