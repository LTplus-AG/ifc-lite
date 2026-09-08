/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  distanceComponents,
  formatSignedDistance,
  formatAxisDeltas,
  formatHorizontalVertical,
} from './components.js';

describe('distanceComponents', () => {
  it('splits a (3, 12, 4) displacement with Y as the UP axis', () => {
    // The whole risk of this slice: the viewer is Y-up, so the ground plane is
    // X/Z. horizontal = hypot(3, 4) = 5, vertical = |12|.
    // Swapping the two formulas gives 12 / 5; treating Z as up gives
    // hypot(3, 12) = 12.369 / 4. Both are killed by these two numbers.
    const c = distanceComponents({ x: 0, y: 0, z: 0 }, { x: 3, y: 12, z: 4 });
    assert.strictEqual(c.horizontal, 5);
    assert.strictEqual(c.vertical, 12);
  });

  it('keeps the same split when the displacement is offset from the origin', () => {
    const c = distanceComponents({ x: 10, y: -4, z: -2 }, { x: 13, y: 8, z: 2 });
    assert.strictEqual(c.dx, 3);
    assert.strictEqual(c.dy, 12);
    assert.strictEqual(c.dz, 4);
    assert.strictEqual(c.horizontal, 5);
    assert.strictEqual(c.vertical, 12);
  });

  it('returns signed deltas (end minus start), not magnitudes', () => {
    const c = distanceComponents({ x: 3, y: 12, z: 4 }, { x: 0, y: 0, z: 0 });
    assert.strictEqual(c.dx, -3);
    assert.strictEqual(c.dy, -12);
    assert.strictEqual(c.dz, -4);
    // ...while horizontal / vertical stay non-negative regardless of direction.
    assert.strictEqual(c.horizontal, 5);
    assert.strictEqual(c.vertical, 12);
  });

  it('is purely vertical for a straight drop and purely horizontal for a level run', () => {
    const drop = distanceComponents({ x: 1, y: 5, z: 2 }, { x: 1, y: 2, z: 2 });
    assert.strictEqual(drop.horizontal, 0);
    assert.strictEqual(drop.vertical, 3);

    const run = distanceComponents({ x: 0, y: 7, z: 0 }, { x: 6, y: 7, z: 8 });
    assert.strictEqual(run.horizontal, 10);
    assert.strictEqual(run.vertical, 0);
  });

  it('agrees with the straight-line distance via Pythagoras', () => {
    const start = { x: -2.5, y: 1.25, z: 0.75 };
    const end = { x: 4.5, y: -3.25, z: 6.75 };
    const c = distanceComponents(start, end);
    const straight = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    assert.ok(Math.abs(Math.hypot(c.horizontal, c.vertical) - straight) < 1e-12);
  });

  it('is zero in every component for a degenerate measurement', () => {
    const c = distanceComponents({ x: 2, y: 3, z: 4 }, { x: 2, y: 3, z: 4 });
    assert.deepStrictEqual(c, { dx: 0, dy: 0, dz: 0, horizontal: 0, vertical: 0 });
  });
});

describe('formatSignedDistance', () => {
  it('keeps the minus sign in front of the unit-scaled magnitude', () => {
    assert.strictEqual(formatSignedDistance(3), '3.000 m');
    assert.strictEqual(formatSignedDistance(-3), '-3.000 m');
    // Sub-metre values scale to cm/mm; the sign must survive that branch.
    assert.strictEqual(formatSignedDistance(-0.25), '-25.0 cm');
    assert.strictEqual(formatSignedDistance(-0.005), '-5.0 mm');
    assert.strictEqual(formatSignedDistance(0), '0.0 mm');
  });
});

describe('measurement readout lines', () => {
  it('labels each axis delta with its own axis', () => {
    const c = distanceComponents({ x: 0, y: 0, z: 0 }, { x: 3, y: 12, z: -4 });
    assert.strictEqual(formatAxisDeltas(c), 'dX 3.000 m  dY 12.000 m  dZ -4.000 m');
  });

  it('labels horizontal H and vertical V', () => {
    const c = distanceComponents({ x: 0, y: 0, z: 0 }, { x: 3, y: 12, z: 4 });
    assert.strictEqual(formatHorizontalVertical(c), 'H 5.000 m  V 12.000 m');
  });

  // #2199: formatDistance() ignoring unitDisplayOverrides — the dX/dY/dZ and
  // H/V breakdowns route through formatSignedDistance / formatDistance
  // internally, so a LENGTHUNIT override set in feet must show up here too,
  // not just on the plain distance figure.
  it('honours a LENGTHUNIT override in the axis-delta line', () => {
    const c = distanceComponents({ x: 0, y: 0, z: 0 }, { x: 3.048, y: 0, z: 0 });
    assert.strictEqual(
      formatAxisDeltas(c, { LENGTHUNIT: 'ft' }),
      'dX 10 ft  dY 0 ft  dZ 0 ft',
    );
  });

  it('honours a LENGTHUNIT override in the horizontal/vertical line', () => {
    const c = distanceComponents({ x: 0, y: 0, z: 0 }, { x: 3, y: 3.048, z: 4 });
    assert.strictEqual(
      formatHorizontalVertical(c, { LENGTHUNIT: 'ft' }),
      'H 16.4042 ft  V 10 ft',
    );
  });

  it('keeps the default auto-scaled metric when overrides is omitted, as before', () => {
    const c = distanceComponents({ x: 0, y: 0, z: 0 }, { x: 3, y: 12, z: -4 });
    // No third argument at all — the pre-#2199-fix call shape must still work.
    assert.strictEqual(formatAxisDeltas(c), 'dX 3.000 m  dY 12.000 m  dZ -4.000 m');
    // horizontal = hypot(dx, dz) = hypot(3, -4) = 5; vertical = |dy| = 12.
    assert.strictEqual(formatHorizontalVertical(c), 'H 5.000 m  V 12.000 m');
  });
});

describe('formatSignedDistance with a LENGTHUNIT override', () => {
  it('converts the magnitude and keeps the sign in front of it', () => {
    assert.strictEqual(formatSignedDistance(3.048, { LENGTHUNIT: 'ft' }), '10 ft');
    assert.strictEqual(formatSignedDistance(-3.048, { LENGTHUNIT: 'ft' }), '-10 ft');
  });

  it('falls back to the auto-scaled metric for an empty override map', () => {
    assert.strictEqual(formatSignedDistance(-0.25, {}), '-25.0 cm');
  });
});
