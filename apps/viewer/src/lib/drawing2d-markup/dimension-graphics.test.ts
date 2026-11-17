/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one geometry function every dimension output draws from, and the
 * default value format (whole millimetres unless a length unit is set).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dimensionGraphics, dimensionText, formatDimensionValue, type DimensionPt } from './dimension-graphics.js';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';

const dim = (patch: Partial<Dimension2D> = {}): Dimension2D => ({
  id: 'd', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 0.5, orientation: 'aligned', ...patch,
});
const plain = (m: number) => m.toFixed(3);
const close = (p: DimensionPt, q: DimensionPt, label: string) => {
  assert.ok(Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9, `${label}: got (${p.x}, ${p.y}), want (${q.x}, ${q.y})`);
};
const near = (p: number, q: number, label: string) => assert.ok(Math.abs(p - q) < 1e-9, `${label}: got ${p}, want ${q}`);

describe('dimensionGraphics', () => {
  it('lays out an aligned dimension at 1:100 in paper millimetres', () => {
    const g = dimensionGraphics(dim(), { paperScale: 100, format: plain });
    // 1 mm on paper is 0.1 m at 1:100.
    close(g.lines[0][0], { x: 0, y: 0.5 }, 'dimension line start');
    close(g.lines[0][1], { x: 4, y: 0.5 }, 'dimension line end');
    assert.equal(g.lines.length, 3, 'dimension line plus two extension lines');
    close(g.lines[1][0], { x: 0, y: 0.1 }, 'extension starts 1 mm off the point');
    close(g.lines[1][1], { x: 0, y: 0.7 }, 'extension overshoots by 2 mm');
    assert.equal(g.ticks.length, 2);
    const [t0, t1] = g.ticks[0];
    near(Math.hypot(t1.x - t0.x, t1.y - t0.y), 0.25, 'tick is 2.5 mm long');
    near(Math.abs(t1.x - t0.x), Math.abs(t1.y - t0.y), 'tick runs at 45°');
    close({ x: (t0.x + t1.x) / 2, y: (t0.y + t1.y) / 2 }, { x: 0, y: 0.5 }, 'tick centred on the line end');
    near(g.text.heightM, 0.25, 'text is 2.5 mm high');
    close(g.text.at, { x: 2, y: 0.5 - 0.1 - 0.125 }, 'text centre sits 1 mm above the line on y-down paper');
    near(g.text.angle, 0, 'drawing angle');
    near(g.text.paperAngle, 0, 'paper angle');
    assert.equal(g.text.value, '4.000');
    near(g.measured, 4, 'measured');
  });

  it('scales sizes with the paper scale, not the measured geometry', () => {
    const g = dimensionGraphics(dim(), { paperScale: 50, format: plain });
    near(g.text.heightM, 0.125, 'text at 1:50');
    close(g.lines[1][1], { x: 0, y: 0.6 }, 'overshoot at 1:50');
    close(g.lines[0][0], { x: 0, y: 0.5 }, 'line position is the stored offset at any scale');
  });

  it('a horizontal dimension of a diagonal measures the x run; a point on the line gets no extension', () => {
    const g = dimensionGraphics(dim({ b: { x: 3, y: 2 }, offset: 1, orientation: 'horizontal' }), { paperScale: 100, format: plain });
    near(g.measured, 3, 'x run');
    close(g.lines[0][0], { x: 0, y: 2 }, 'line start');
    close(g.lines[0][1], { x: 3, y: 2 }, 'line end');
    assert.equal(g.lines.length, 2, 'b lies on the dimension line, so only a has an extension');
  });

  it('turns vertical text to read bottom to top', () => {
    const g = dimensionGraphics(dim({ b: { x: 0, y: 3 }, offset: 1 }), { paperScale: 100, format: plain });
    near(g.text.paperAngle, -Math.PI / 2, 'paper angle');
    near(g.measured, 3, 'measured');
    // Either direction the points were picked in gives the same reading.
    const reversed = dimensionGraphics(dim({ a: { x: 0, y: 3 }, b: { x: 0, y: 0 }, offset: -1 }), { paperScale: 100, format: plain });
    near(reversed.text.paperAngle, -Math.PI / 2, 'reversed paper angle');
  });

  it('keeps text upright after a section flip', () => {
    const flipped = dimensionGraphics(dim(), { paperScale: 100, format: plain, flip: { flipX: true, flipY: false } });
    near(flipped.text.paperAngle, 0, 'upright on paper');
    near(Math.abs(flipped.text.angle), Math.PI, 'reversed in drawing space, which the flip mirrors back');
    const both = dimensionGraphics(dim(), { paperScale: 100, format: plain, flip: { flipX: true, flipY: true } });
    near(both.text.paperAngle, 0, 'upright with both axes flipped');
    // Text still sits on the paper-up side of the line: drawing +y is paper-up once y is flipped.
    assert.ok(both.text.at.y > 0.5, `text above the line on flipped paper, got y=${both.text.at.y}`);
  });

  it('a zero offset puts the line through the points, without extension lines', () => {
    const g = dimensionGraphics(dim({ offset: 0 }), { paperScale: 100, format: plain });
    assert.equal(g.lines.length, 1);
    close(g.lines[0][0], { x: 0, y: 0 }, 'line start');
  });

  it('applies a text override around the measured value', () => {
    const g = dimensionGraphics(dim({ text: '<> clear' }), { paperScale: 100, format: (m) => formatDimensionValue(m) });
    assert.equal(g.text.value, '4000 clear');
    assert.equal(dimensionText('<> (<>)', '12'), '12 (12)');
    assert.equal(dimensionText('TYP.', '12'), 'TYP.', 'an override without <> replaces the value');
    assert.equal(dimensionText(undefined, '12'), '12');
  });
});

describe('formatDimensionValue', () => {
  it('prints whole millimetres with no unit by default', () => {
    assert.equal(formatDimensionValue(4.2624), '4262');
    assert.equal(formatDimensionValue(4.2626), '4263');
    assert.equal(formatDimensionValue(0.0004), '0', 'never -0 or a fraction');
  });

  it('honours a viewer length unit override with its symbol', () => {
    const value = formatDimensionValue(4.2624, { LENGTHUNIT: 'm' });
    assert.ok(value.endsWith(' m'), `metre override, got ${value}`);
    assert.equal(Number.parseFloat(value.replace(',', '.')), 4.2624);
    assert.ok(formatDimensionValue(4.2624, { LENGTHUNIT: 'mm' }).endsWith(' mm'), 'mm override carries its symbol');
  });
});
