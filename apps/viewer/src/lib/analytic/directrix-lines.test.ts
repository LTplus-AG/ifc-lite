/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { directrixLineVertices } from './directrix-lines.js';
import { directrixDisplayLines, directrixDisplayPoint } from './directrix-frame.js';

describe('selected analytic directrix display (#5778)', () => {
  it('draws a line then a quarter-circle with an authored 0.5 mm sagitta bound', () => {
    const data = directrixLineVertices([
      { type: 'line', start: [0, 0, 0], end: [1, 0, 0] },
      { type: 'arc', center: [1, 1, 0], normal: [0, 0, 1], x_axis: [1, 0, 0],
        radius: 1, start_angle: -Math.PI / 2, sweep_angle: Math.PI / 2 },
    ]);
    assert.deepEqual(data.slice(0, 6), [0, 0, 0, 1, 0, 0]);
    assert.ok(data.length > 12, 'the curve has render-only chord segments');
    assert.ok(Math.abs(data[6] - 1) < 1e-12);
    assert.ok(Math.abs(data[7]) < 1e-12);
    assert.ok(Math.abs(data.at(-3)! - 2) < 1e-12);
    assert.ok(Math.abs(data.at(-2)! - 1) < 1e-12);
    // The middle of each unit-circle chord is the worst display deviation.
    for (let index = 6; index < data.length; index += 6) {
      const x = (data[index] + data[index + 3]) / 2 - 1;
      const y = (data[index + 1] + data[index + 4]) / 2 - 1;
      assert.ok(1 - Math.hypot(x, y) <= 0.0005 + 1e-12);
    }
  });

  it('preserves signed reverse sweeps and bounds hostile output', () => {
    const reverse = directrixLineVertices([{ type: 'arc', center: [0, 0, 0], normal: [0, 0, 1],
      x_axis: [1, 0, 0], radius: 0.1, start_angle: Math.PI / 2, sweep_angle: -Math.PI / 2 }]);
    assert.ok(Math.abs(reverse[0]) < 1e-12 && Math.abs(reverse[1] - 0.1) < 1e-12);
    assert.ok(Math.abs(reverse.at(-3)! - 0.1) < 1e-12 && Math.abs(reverse.at(-2)!) < 1e-12);
    assert.throws(() => directrixLineVertices([
      { type: 'line', start: [0, 0, 0], end: [1, 0, 0] },
      { type: 'line', start: [1, 0, 0], end: [2, 0, 0] },
    ], 1), /display edge budget/);
  });

  it('subtracts a 5,000 km RTC anchor before display placement and preserves millimetres', () => {
    const origin = { x: 5_000_000, y: 20, z: 30 };
    const zero = { x: 0, y: 0, z: 0 };
    const box = { min: zero, max: zero };
    const frame: CoordinateInfo = { originShift: zero, originalBounds: box, shiftedBounds: box,
      hasLargeCoordinates: false, wasmRtcOffset: origin };
    const placement = { translation: [4, 5, 6] as const,
      rotation: { angle: 0, pivot: [0, 0, 0] as const } };
    const display = directrixDisplayLines([
      5_000_000.001, 20, 30,
      5_000_000.003, 20, 30,
    ], frame, placement);
    assert.ok(Math.abs(display[0] - 4.001) < 1e-9);
    assert.ok(Math.abs(display[3] - 4.003) < 1e-9);
    assert.deepEqual(display.filter((_, index) => index % 3 !== 0), [6, -5, 6, -5]);
    // A same-CRS federation map applies once to each already-rebased point.
    const aligned = directrixDisplayLines([5_000_000.001, 20, 30], frame, placement,
      (x, y, z) => [x + 10, y, z]);
    assert.ok(Math.abs(aligned[0] - 14.001) < 1e-9);
    const mirror = (x: number, y: number, z: number) => [-x, y, z] as const;
    const mirrored = directrixDisplayPoint([5_000_000.001, 20, 30], frame, placement, mirror);
    assert.ok(Math.abs(mirrored[0] - 3.999) < 1e-9);
    assert.deepEqual(mirrored, directrixDisplayLines([5_000_000.001, 20, 30], frame, placement, mirror));
  });
});
