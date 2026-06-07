/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isGeometricDataName } from './geometricData.js';

describe('isGeometricDataName — data/geometry boundary', () => {
  it('flags placement/position data that authoring tools leak into property sets', () => {
    for (const name of [
      'Elevation',
      'Elevation at Bottom',
      'Elevation at Top',
      'Height Offset From Level',
      'Base Offset',
      'Top Offset',
      'Bottom Offset',
      'Reference Level',
      'Z Coordinate',
      'Z Offset',
      'Placement',
      'ObjectPlacement',
    ]) {
      assert.equal(isGeometricDataName(name), true, `${name} should be geometric`);
    }
  });

  it('does NOT flag semantic data — a move must not strip real attributes/properties', () => {
    for (const name of [
      'Name',
      'Description',
      'ObjectType',
      'FireRating',
      'IsExternal',
      'LoadBearing',
      'Reference',
      'Pset_SlabCommon',
      'AcousticRating',
      'Combustible',
      'ThermalTransmittance',
      'Status',
      'Mark',
      'Material',
      // Generic terms that are just as often semantic — must NOT be excluded.
      'Location',
      'Position',
      'Datum',
      'Offset',
    ]) {
      assert.equal(isGeometricDataName(name), false, `${name} should be semantic data`);
    }
  });
});
