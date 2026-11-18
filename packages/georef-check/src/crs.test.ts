/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { epsgCodeFromLabel, epsgCodeFromWkt, utmZoneOfEpsg } from './crs.js';
import { placementOrigin, type EntityReader } from './coordinates.js';

describe('epsgCodeFromLabel', () => {
  it.each([
    ['EPSG:2056', 2056],
    ['epsg 25832', 25832],
    ['EPSG::7415', 7415],
    ['urn:ogc:def:crs:EPSG::2056', 2056],
    ['http://www.opengis.net/def/crs/EPSG/0/32633', 32633],
    ['7415', 7415],
    ['CH1903+ / LV95', undefined],
    ['', undefined],
  ])('%s → %s', (label, code) => {
    expect(epsgCodeFromLabel(label)).toBe(code);
  });
});

describe('epsgCodeFromWkt', () => {
  it('takes the CRS identifier, not a nested datum one (WKT1 and WKT2)', () => {
    expect(epsgCodeFromWkt('PROJCS["x",GEOGCS["y",AUTHORITY["EPSG","4258"]],AUTHORITY["EPSG","25832"]]')).toBe(25832);
    expect(epsgCodeFromWkt('PROJCRS["x",BASEGEOGCRS["y",ID["EPSG",4150]],ID["EPSG",2056]]')).toBe(2056);
    expect(epsgCodeFromWkt('PROJCRS["custom"]')).toBeUndefined();
  });
});

describe('utmZoneOfEpsg', () => {
  it('knows the plain and zone-prefixed UTM codes and nothing else', () => {
    expect(utmZoneOfEpsg(32633)).toEqual({ zone: 33, south: false, zonePrefixed: false });
    expect(utmZoneOfEpsg(32760)).toEqual({ zone: 60, south: true, zonePrefixed: false });
    expect(utmZoneOfEpsg(25832)).toEqual({ zone: 32, south: false, zonePrefixed: false });
    expect(utmZoneOfEpsg(3040)?.zone).toBe(28);
    expect(utmZoneOfEpsg(26923)?.zone).toBe(23);
    expect(utmZoneOfEpsg(4647)).toEqual({ zone: 32, south: false, zonePrefixed: true });
    expect(utmZoneOfEpsg(3006)).toBeUndefined();
    expect(utmZoneOfEpsg(2056)).toBeUndefined();
  });
});

describe('placementOrigin', () => {
  const reader = (entities: Record<number, [string, unknown[]]>): EntityReader => ({
    get: (id) => (entities[id] ? { type: entities[id][0], attributes: entities[id][1] } : undefined),
    idsOfType: () => [],
  });

  it('composes PlacementRelTo with the parent turn', () => {
    const r = reader({
      1: ['IFCCARTESIANPOINT', [[100, 0, 0]]],
      2: ['IFCDIRECTION', [[0, 1, 0]]], // parent x axis = world +y (turned 90°)
      3: ['IFCAXIS2PLACEMENT3D', [1, null, 2]],
      4: ['IFCLOCALPLACEMENT', [null, 3]],
      5: ['IFCCARTESIANPOINT', [[10, 0, 0]]],
      6: ['IFCAXIS2PLACEMENT3D', [5, null, null]],
      7: ['IFCLOCALPLACEMENT', [4, 6]],
    });
    expect(placementOrigin(r, 7)).toEqual({ x: 100, y: 10, z: 0 });
  });

  it('refuses a cyclic chain instead of looping', () => {
    const r = reader({
      1: ['IFCCARTESIANPOINT', [[1, 2, 3]]],
      2: ['IFCAXIS2PLACEMENT3D', [1, null, null]],
      3: ['IFCLOCALPLACEMENT', [4, 2]],
      4: ['IFCLOCALPLACEMENT', [3, 2]],
    });
    expect(placementOrigin(r, 3)).toBeUndefined();
  });
});
