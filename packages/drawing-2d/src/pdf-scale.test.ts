/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scale/extent arithmetic for the scaled PDF section export (issue #2042).
 */

import { describe, expect, it } from 'vitest';
import { computePdfScaleLayout, worldPointToPdfMm, worldLengthToPdfMm } from './pdf-scale.js';
import type { Bounds2D } from './types.js';

const bounds10x6: Bounds2D = { min: { x: 0, y: 0 }, max: { x: 10, y: 6 } };

describe('computePdfScaleLayout', () => {
  it('maps 1:100 to 10mm-per-metre (1cm = 1m on paper)', () => {
    const { transform } = computePdfScaleLayout(bounds10x6, 100, 0);
    expect(transform.worldToMm).toBeCloseTo(10, 10);
  });

  it('maps 1:50 to 20mm-per-metre', () => {
    const { transform } = computePdfScaleLayout(bounds10x6, 50, 0);
    expect(transform.worldToMm).toBeCloseTo(20, 10);
  });

  it('sizes the page to the drawing extent plus margin on every side, not a fixed paper size', () => {
    const { page } = computePdfScaleLayout(bounds10x6, 100, 10);
    // 10m wide at 1:100 -> 100mm, + 10mm margin each side = 120mm
    expect(page.widthMm).toBeCloseTo(120, 10);
    // 6m tall at 1:100 -> 60mm, + 10mm margin each side = 80mm
    expect(page.heightMm).toBeCloseTo(80, 10);
  });

  it('places bounds.min and bounds.max exactly `margin` mm inside the page edges (no silent re-fit/shrink)', () => {
    const margin = 15;
    const { transform, page } = computePdfScaleLayout(bounds10x6, 100, margin);
    const pMin = worldPointToPdfMm(bounds10x6.min, transform);
    const pMax = worldPointToPdfMm(bounds10x6.max, transform);

    // X is not flipped: min.x -> left margin, max.x -> page width - margin.
    expect(pMin.x).toBeCloseTo(margin, 10);
    expect(pMax.x).toBeCloseTo(page.widthMm - margin, 10);

    // Y is flipped: world max.y (top of drawing) -> paper top margin;
    // world min.y (bottom of drawing) -> paper bottom margin.
    expect(pMax.y).toBeCloseTo(margin, 10);
    expect(pMin.y).toBeCloseTo(page.heightMm - margin, 10);
  });

  it('defaults the margin to 10mm when omitted', () => {
    const { page } = computePdfScaleLayout(bounds10x6, 100);
    expect(page.widthMm).toBeCloseTo(120, 10);
    expect(page.heightMm).toBeCloseTo(80, 10);
  });

  it('rejects a zero scale factor', () => {
    expect(() => computePdfScaleLayout(bounds10x6, 0)).toThrow(/scale factor/i);
  });

  it('rejects a negative scale factor', () => {
    expect(() => computePdfScaleLayout(bounds10x6, -100)).toThrow(/scale factor/i);
  });

  it('rejects a non-finite scale factor', () => {
    expect(() => computePdfScaleLayout(bounds10x6, NaN)).toThrow(/scale factor/i);
    expect(() => computePdfScaleLayout(bounds10x6, Infinity)).toThrow(/scale factor/i);
  });

  it('rejects a negative margin', () => {
    expect(() => computePdfScaleLayout(bounds10x6, 100, -1)).toThrow(/margin/i);
  });

  it('rejects non-finite bounds', () => {
    const bad: Bounds2D = { min: { x: 0, y: 0 }, max: { x: NaN, y: 6 } };
    expect(() => computePdfScaleLayout(bad, 100)).toThrow(/bounds/i);
  });

  it('rejects inverted bounds (max < min)', () => {
    const bad: Bounds2D = { min: { x: 10, y: 0 }, max: { x: 0, y: 6 } };
    expect(() => computePdfScaleLayout(bad, 100)).toThrow(/bounds/i);
  });

  it('handles zero-size bounds (a degenerate but not inverted drawing) without throwing', () => {
    const point: Bounds2D = { min: { x: 5, y: 5 }, max: { x: 5, y: 5 } };
    const { page } = computePdfScaleLayout(point, 100, 10);
    expect(page.widthMm).toBeCloseTo(20, 10);
    expect(page.heightMm).toBeCloseTo(20, 10);
  });
});

describe('worldPointToPdfMm', () => {
  it('flips Y (world north/up becomes paper down)', () => {
    const { transform } = computePdfScaleLayout(bounds10x6, 100, 0);
    const top = worldPointToPdfMm({ x: 0, y: 6 }, transform);
    const bottom = worldPointToPdfMm({ x: 0, y: 0 }, transform);
    expect(top.y).toBeLessThan(bottom.y);
  });
});

describe('worldLengthToPdfMm', () => {
  it('scales a world-space length (metres) by the same factor as points, with no offset', () => {
    const { transform } = computePdfScaleLayout(bounds10x6, 100, 10);
    // A 1m wall at 1:100 is 10mm on paper, regardless of margin/offset.
    expect(worldLengthToPdfMm(1, transform)).toBeCloseTo(10, 10);
  });

  it('scales proportionally to the chosen scale factor', () => {
    const { transform: t50 } = computePdfScaleLayout(bounds10x6, 50, 10);
    const { transform: t200 } = computePdfScaleLayout(bounds10x6, 200, 10);
    expect(worldLengthToPdfMm(1, t50)).toBeCloseTo(20, 10);
    expect(worldLengthToPdfMm(1, t200)).toBeCloseTo(5, 10);
  });
});
