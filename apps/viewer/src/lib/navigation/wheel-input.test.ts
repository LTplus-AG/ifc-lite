/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWheelZoomSensitivity,
  wheelDeltaPx,
  wheelZoomScale,
  wheelZoomSensitivityFactor,
  WHEEL_PAGE_PX,
  WHEEL_ZOOM_SENSITIVITIES,
} from './wheel-input.js';

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} vs ${expected}`);

describe('wheel delta in CSS px (#9507)', () => {
  it('passes pixel deltas through', () => {
    assert.equal(wheelDeltaPx(120, 0), 120);
    assert.equal(wheelDeltaPx(-3.5, 0), -3.5);
  });

  it('reads a three-line Firefox notch as the 100 px notch Chromium reports', () => {
    near(wheelDeltaPx(3, 1), 100);
    near(wheelDeltaPx(-3, 1), -100);
  });

  it('reads pages as the caller\'s page height, or a default one', () => {
    assert.equal(wheelDeltaPx(1, 2, 600), 600);
    assert.equal(wheelDeltaPx(1, 2), WHEEL_PAGE_PX);
  });

  it('reads non-finite input, and a delta that overflows, as no movement', () => {
    assert.equal(wheelDeltaPx(Number.NaN, 0), 0);
    assert.equal(wheelDeltaPx(Number.POSITIVE_INFINITY, 0), 0);
    assert.equal(wheelDeltaPx(Number.MAX_VALUE, 2, 10), 0);
  });
});

describe('2D wheel zoom scale (#9507)', () => {
  it('zooms 10 % per 100 px notch, in on scroll up and out on scroll down', () => {
    near(wheelZoomScale(-100, 1), 1.1);
    near(wheelZoomScale(100, 1), 1 / 1.1);
    assert.equal(wheelZoomScale(0, 1), 1);
  });

  it('scales the exponent by the factor, so fast doubles a notch and slow halves it', () => {
    near(wheelZoomScale(-100, wheelZoomSensitivityFactor('fast')), 1.1 ** 2);
    near(wheelZoomScale(-100, wheelZoomSensitivityFactor('slow')), Math.sqrt(1.1));
  });

  it('caps one event at 25 % either way', () => {
    near(wheelZoomScale(-1e6, 1), 1.25);
    near(wheelZoomScale(1e6, 1), 1 / 1.25);
    assert.equal(wheelZoomScale(Number.NaN, 1), 1);
  });
});

describe('wheel zoom sensitivity setting (#9507)', () => {
  it('orders the levels slow < normal < fast, with normal unchanged', () => {
    const factors = WHEEL_ZOOM_SENSITIVITIES.map(wheelZoomSensitivityFactor);
    assert.deepEqual([...factors].sort((a, b) => a - b), factors);
    assert.equal(wheelZoomSensitivityFactor('normal'), 1);
  });

  it('parses saved values and falls back to normal for anything else', () => {
    for (const s of WHEEL_ZOOM_SENSITIVITIES) assert.equal(parseWheelZoomSensitivity(s), s);
    assert.equal(parseWheelZoomSensitivity(null), 'normal');
    assert.equal(parseWheelZoomSensitivity('turbo'), 'normal');
  });
});
