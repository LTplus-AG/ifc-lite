/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  sunDirectionForTimeOfDay,
  formatHourOfDay,
  SUN_DAY_START,
  SUN_DAY_END,
} from './sun-time-of-day.js';

function isUnit(v: [number, number, number]): boolean {
  const len = Math.hypot(v[0], v[1], v[2]);
  return Math.abs(len - 1) < 1e-6;
}

describe('sunDirectionForTimeOfDay', () => {
  it('returns a unit vector at every hour', () => {
    for (let h = 0; h <= 24; h += 0.5) {
      assert.ok(isUnit(sunDirectionForTimeOfDay(h).sunDirection), `not unit at ${h}h`);
    }
  });

  it('rises in the east (+X) and sets in the west (−X)', () => {
    const dawn = sunDirectionForTimeOfDay(SUN_DAY_START);
    const dusk = sunDirectionForTimeOfDay(SUN_DAY_END);
    assert.ok(dawn.sunDirection[0] > 0.5, `dawn not eastward: ${dawn.sunDirection[0]}`);
    assert.ok(dusk.sunDirection[0] < -0.5, `dusk not westward: ${dusk.sunDirection[0]}`);
  });

  it('peaks at noon (highest altitude, sun nearly overhead)', () => {
    const noon = sunDirectionForTimeOfDay((SUN_DAY_START + SUN_DAY_END) / 2);
    const morning = sunDirectionForTimeOfDay(9);
    assert.ok(noon.altitudeDeg > morning.altitudeDeg, 'noon should be higher than morning');
    assert.ok(noon.sunDirection[1] > 0.85, `noon sun not high enough: y=${noon.sunDirection[1]}`);
  });

  it('keeps the sun above the horizon (finite shadows) at the day edges', () => {
    assert.ok(sunDirectionForTimeOfDay(SUN_DAY_START).altitudeDeg >= 6, 'dawn altitude floored');
    assert.ok(sunDirectionForTimeOfDay(SUN_DAY_END).altitudeDeg >= 6, 'dusk altitude floored');
    assert.ok(sunDirectionForTimeOfDay(SUN_DAY_START).sunDirection[1] > 0, 'dawn sun below horizon');
  });

  it('clamps out-of-range and non-finite input to the day window', () => {
    assert.deepEqual(sunDirectionForTimeOfDay(3).sunDirection, sunDirectionForTimeOfDay(SUN_DAY_START).sunDirection);
    assert.deepEqual(sunDirectionForTimeOfDay(22).sunDirection, sunDirectionForTimeOfDay(SUN_DAY_END).sunDirection);
    assert.ok(isUnit(sunDirectionForTimeOfDay(NaN).sunDirection));
  });
});

describe('formatHourOfDay', () => {
  it('formats fractional hours as HH:MM', () => {
    assert.equal(formatHourOfDay(6), '06:00');
    assert.equal(formatHourOfDay(13.5), '13:30');
    assert.equal(formatHourOfDay(9.25), '09:15');
  });
});
