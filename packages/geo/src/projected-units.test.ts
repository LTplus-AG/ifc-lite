/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { projectedLinearUnit, projectedUnitToMetres } from './projected-units.js';

describe('proj4 projected-unit boundary (#5048)', () => {
  it('normalizes metre, international-foot, and US-survey-foot definitions', () => {
    assert.equal(projectedUnitToMetres('+proj=utm +units=m'), 1);
    assert.equal(projectedUnitToMetres('+proj=lcc +units=ft'), 0.3048);
    assert.equal(projectedUnitToMetres('+proj=lcc +units=us-ft'), 1200 / 3937);
    assert.equal(projectedUnitToMetres('+proj=lcc +to_meter=1200/3937'), 1200 / 3937);
  });

  it('fails closed for malformed or unsupported projected units', () => {
    assert.equal(projectedUnitToMetres('+proj=lcc +units=furlong'), null);
    assert.equal(projectedUnitToMetres('+proj=lcc +to_meter=0'), null);
    assert.equal(projectedUnitToMetres('+proj=lcc +to_meter=broken'), null);
    assert.equal(projectedUnitToMetres('+proj=lcc +units=constructor'), null, 'an Object.prototype key is not a unit');
  });

  it('names the unit, also when only its factor is stated', () => {
    assert.deepEqual(projectedLinearUnit('+proj=lcc +units=us-ft'), { name: 'US survey foot', toMetres: 1200 / 3937 });
    assert.deepEqual(projectedLinearUnit('+proj=lcc +to_meter=0.3048'), { name: 'foot', toMetres: 0.3048 });
    assert.deepEqual(projectedLinearUnit('+proj=lcc +to_meter=0.2'), { name: null, toMetres: 0.2 });
    assert.deepEqual(projectedLinearUnit('+proj=utm +zone=32'), { name: 'metre', toMetres: 1 });
  });
});
