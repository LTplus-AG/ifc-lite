/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { projectedUnitToMetres } from './projected-units.js';

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
  });
});
