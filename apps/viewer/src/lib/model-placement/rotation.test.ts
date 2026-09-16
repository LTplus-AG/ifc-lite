/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { degreesToRadians, equalRotation, finiteRotation, normalizeAngle, parseRotationDegrees,
  radiansToDegrees, rotateWorkspacePoint, ZERO_ROTATION } from './rotation.js';
import type { Translation } from './translation.js';

describe('rotation values', () => {
  it('parses degrees, a decimal comma and a degree suffix, and nothing else', () => {
    for (const [text, degrees] of [['90', 90], ['-22.5', -22.5], [' 45 ° ', 45], ['30deg', 30],
      ['12,5', 12.5], ['1e2', 100]] as const) {
      assert.ok(Math.abs(radiansToDegrees(parseRotationDegrees(text)) - normalizeAngle(degreesToRadians(degrees)) * 180 / Math.PI) < 1e-9, text);
    }
    for (const text of ['', '90 + 1', '90m', '1.2.3', '90rad', 'abc', '1,000.5']) {
      assert.throws(() => parseRotationDegrees(text), /degrees/i, `accepted ${JSON.stringify(text)}`);
    }
  });

  it('wraps to (-180, 180] so an edited heading cannot drift without bound', () => {
    assert.equal(Math.round(radiansToDegrees(degreesToRadians(450))), 90);
    assert.equal(Math.round(radiansToDegrees(degreesToRadians(-270))), 90);
    // 180 and -180 are one value, so two equal headings cannot compare unequal.
    assert.equal(normalizeAngle(Math.PI), normalizeAngle(-Math.PI));
    assert.equal(normalizeAngle(Math.PI), Math.PI);
    assert.throws(() => normalizeAngle(Number.NaN), /finite/);
  });

  it('positive is counter-clockwise seen from above: +X turns toward +Y', () => {
    const turned = rotateWorkspacePoint([1, 0, 7], { angle: degreesToRadians(90), pivot: [0, 0, 0] });
    assert.ok(Math.abs(turned[0]) < 1e-9 && Math.abs(turned[1] - 1) < 1e-9, `got ${turned}`);
    // Elevation is untouched — this is a yaw, not a tilt.
    assert.equal(turned[2], 7);
  });

  it('turns about the pivot, not the origin', () => {
    const pivot: Translation = [10, 4, 0];
    assert.deepEqual(rotateWorkspacePoint(pivot, { angle: degreesToRadians(37), pivot }), pivot);
    const moved = rotateWorkspacePoint([11, 4, 0], { angle: degreesToRadians(90), pivot });
    assert.ok(Math.abs(moved[0] - 10) < 1e-9 && Math.abs(moved[1] - 5) < 1e-9, `got ${moved}`);
  });

  it('two zero-angle rotations are equal whatever their pivots', () => {
    assert.ok(equalRotation(ZERO_ROTATION, { angle: 0, pivot: [500, -3, 9] }));
    assert.ok(!equalRotation({ angle: 1, pivot: [0, 0, 0] }, { angle: 1, pivot: [1, 0, 0] }));
    assert.ok(!equalRotation({ angle: 1, pivot: [0, 0, 0] }, { angle: -1, pivot: [0, 0, 0] }));
  });

  it('rejects malformed rotation records', () => {
    for (const value of [null, undefined, 1, 'x', {}, { angle: 1 }, { angle: 'x', pivot: [0, 0, 0] },
      { angle: 1, pivot: [0, 0] }, { angle: Number.NaN, pivot: [0, 0, 0] }, { angle: 1, pivot: [0, 0, Number.NaN] }]) {
      assert.equal(finiteRotation(value), false, `accepted ${JSON.stringify(value)}`);
    }
    assert.ok(finiteRotation({ angle: 0.5, pivot: [1, 2, 3] }));
  });
});
