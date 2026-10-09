/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

/** #7220: prefix powers and summing native zone shares can differ by a few ULPs.
 * No absolute tolerance: a missing or incorrectly scaled physical value fails. */
export function assertSiVolume(actual: number | undefined, expected: number, message: string) {
  assert.ok(Number.isFinite(expected), 'the native oracle volume must be finite');
  assert.ok(actual !== undefined && Number.isFinite(actual), message);
  assert.ok(Math.abs(actual - expected) <= 8 * Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected)),
    `${message}: ${actual} versus ${expected}`);
}
