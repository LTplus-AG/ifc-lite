/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { inclination, formatInclination } from './inclination.js';
import { distanceComponents } from './components.js';

/** Build components the way the panel does, from two picked points. */
const between = (
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
) => distanceComponents(start, end);

describe('inclination', () => {
  it('derives degrees from the vertical over the horizontal, not the reverse', () => {
    // rise 5, run 5*sqrt(3) => 30 degrees. Swapping the atan2 arguments gives
    // 60, which this pins. Run is laid out as (dx=15, dz=0) so horizontal is
    // unambiguous.
    const run = 5 * Math.sqrt(3);
    const i = inclination(between({ x: 0, y: 0, z: 0 }, { x: run, y: 5, z: 0 }));
    assert.ok(Math.abs(i.degrees - 30) < 1e-9, `expected 30, got ${i.degrees}`);
  });

  it('computes percent as rise over run, not run over rise', () => {
    // rise 1 over run 4 is a 25% grade. The inverse would be 400%.
    const i = inclination(between({ x: 0, y: 0, z: 0 }, { x: 4, y: 1, z: 0 }));
    assert.ok(Math.abs(i.percent - 25) < 1e-9, `expected 25, got ${i.percent}`);
  });

  it('computes the 1:n ratio as run per unit rise — the reciprocal of percent', () => {
    // A 1:20 fall is the drainage convention: 1 vertical to 20 horizontal.
    // Inverting this reads a gentle fall as 1:0.05 and vice versa, so the
    // number here is the whole point of the field.
    const i = inclination(between({ x: 0, y: 0, z: 0 }, { x: 20, y: 1, z: 0 }));
    assert.ok(Math.abs((i.ratioRun ?? 0) - 20) < 1e-9, `expected 20, got ${i.ratioRun}`);
    // ...and it really is the reciprocal of the percentage's fraction.
    assert.ok(Math.abs(i.percent - 5) < 1e-9);
  });

  it('uses the Y-up horizontal, so a run spread across X and Z is one run', () => {
    // dx=3, dz=4 is a run of 5, rise 5 => 45 degrees. Treating dz as the
    // vertical (the Z-up mistake `components.ts` warns about) would give a
    // run of hypot(3,5) and a rise of 4 — about 34 degrees.
    const i = inclination(between({ x: 0, y: 0, z: 0 }, { x: 3, y: 5, z: 4 }));
    assert.ok(Math.abs(i.degrees - 45) < 1e-9, `expected 45, got ${i.degrees}`);
    assert.strictEqual(i.kind, 'sloped');
  });

  it('is unsigned: a fall and a rise of the same gradient read alike', () => {
    const up = inclination(between({ x: 0, y: 0, z: 0 }, { x: 4, y: 1, z: 0 }));
    const down = inclination(between({ x: 0, y: 0, z: 0 }, { x: 4, y: -1, z: 0 }));
    assert.deepStrictEqual(down, up);
  });

  describe('the four kinds', () => {
    it('calls a plumb drop vertical, with an infinite gradient', () => {
      const i = inclination(between({ x: 1, y: 9, z: 2 }, { x: 1, y: 3, z: 2 }));
      assert.strictEqual(i.kind, 'vertical');
      assert.strictEqual(i.degrees, 90);
      assert.strictEqual(i.percent, Infinity);
      assert.strictEqual(i.ratioRun, 0);
    });

    it('calls a level run level, with no ratio', () => {
      const i = inclination(between({ x: 0, y: 7, z: 0 }, { x: 6, y: 7, z: 8 }));
      assert.strictEqual(i.kind, 'level');
      assert.strictEqual(i.degrees, 0);
      assert.strictEqual(i.percent, 0);
      assert.strictEqual(i.ratioRun, null);
    });

    it('separates a zero-length pick from a level run', () => {
      // These two produce an IDENTICAL (0, 0, null) numeric triple, so `kind`
      // is the only thing that can tell them apart. If the discriminator is
      // ever collapsed, this is what catches it.
      const nothing = inclination(between({ x: 2, y: 3, z: 4 }, { x: 2, y: 3, z: 4 }));
      const level = inclination(between({ x: 0, y: 3, z: 0 }, { x: 5, y: 3, z: 0 }));
      assert.strictEqual(nothing.kind, 'degenerate');
      assert.strictEqual(level.kind, 'level');
      assert.strictEqual(nothing.degrees, level.degrees);
      assert.strictEqual(nothing.percent, level.percent);
      assert.strictEqual(nothing.ratioRun, level.ratioRun);
    });

    it('never produces NaN, whatever the segment', () => {
      for (const end of [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 5, z: 0 },
        { x: 5, y: 0, z: 0 },
        { x: 5, y: 5, z: 5 },
      ]) {
        const i = inclination(between({ x: 0, y: 0, z: 0 }, end));
        assert.ok(!Number.isNaN(i.degrees), `NaN degrees for ${JSON.stringify(end)}`);
        assert.ok(!Number.isNaN(i.percent), `NaN percent for ${JSON.stringify(end)}`);
        assert.ok(i.ratioRun === null || !Number.isNaN(i.ratioRun));
      }
    });
  });
});

describe('formatInclination', () => {
  it('shows degrees, percent and ratio together for a real gradient', () => {
    const i = inclination(between({ x: 0, y: 0, z: 0 }, { x: 20, y: 1, z: 0 }));
    assert.strictEqual(formatInclination(i), '2.9°  5.0%  1:20.0');
  });

  it('says "vertical" rather than printing an infinite percentage', () => {
    const i = inclination(between({ x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }));
    assert.strictEqual(formatInclination(i), '90.0°  vertical');
    assert.ok(!formatInclination(i).includes('Infinity'));
  });

  it('says "level" for a horizontal run', () => {
    const i = inclination(between({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 }));
    assert.strictEqual(formatInclination(i), '0.0°  0.0%  level');
  });

  it('reports nothing measured for a zero-length pick, not "level"', () => {
    // Reporting a degenerate pick as level would assert a fact the pick never
    // established. This is the reason `kind` exists at all.
    const i = inclination(between({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }));
    assert.strictEqual(formatInclination(i), '—');
  });
});
