/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { PROJ4_OVERRIDES, applyProj4Overrides } from '../../../scripts/epsg-proj4-overrides.js';
import { lookupEpsgByCode } from '../src/epsg-index.js';
import { summarizeEntry, inheritCompoundProj4 } from '../../../scripts/epsg-registry.js';

// The generator writes these strings into the bundle after every fetch; the
// bundle carrying exactly the override table is the contract checked here
// (#7658). Placement accuracy is checked by the control-point fixtures.
describe('bundled EPSG index carries every proj4 override', () => {
  for (const [code, definition] of PROJ4_OVERRIDES) {
    it(`EPSG:${code}`, async () => {
      expect((await lookupEpsgByCode(code))?.proj4).toBe(definition);
    });
  }
});

// Geocentric DB_REF has no fixture (the round-trip verifier is 2D). PROJ 9.3:
// EPSG:5828 (4040000, 533000, 4895000) -> WGS84 7.514840053 / 50.410395459.
it('EPSG:5828 (geocentric DB_REF) applies the datum shift (#7658)', async () => {
  const definition = (await lookupEpsgByCode('5828'))?.proj4;
  expect(definition).toBeTruthy();
  const [lon, lat] = proj4(definition!, 'WGS84', [4_040_000, 533_000, 4_895_000]);
  expect(lon).toBeCloseTo(7.514840053, 6);
  expect(lat).toBeCloseTo(50.410395459, 6);
});

it('applyProj4Overrides rewrites listed codes and leaves others alone', () => {
  const wgs84 = '+proj=longlat +datum=WGS84 +no_defs';
  const entries = [
    { code: '9933', proj4: '+proj=tmerc +ellps=bessel +units=m' },
    { code: '5683', proj4: PROJ4_OVERRIDES.get('5683') },
    { code: '4326', proj4: wgs84 },
  ];
  expect(applyProj4Overrides(entries)).toMatch(/^proj4 overrides: changed 9933; unchanged 5683;/);
  expect(entries.map((entry) => entry.proj4)).toEqual([
    PROJ4_OVERRIDES.get('9933'),
    PROJ4_OVERRIDES.get('5683'),
    wgs84,
  ]);
});

// Deprecated compound codes are still authored in IFC files. Their XY
// operation must inherit the corrected horizontal datum shift (#7658), rather
// than epsg.io's datum-less Bessel definition. Relations: EPSG Registry
// https://apps.epsg.org/api/v1/CompoundCoordRefSystem/{code}.
describe('DB_REF + DHHN92 compounds inherit the bundled horizontal operation (#7658)', () => {
  for (const [compound, horizontal] of [['5832', '5682'], ['5833', '5683'], ['5834', '5684'], ['5835', '5685']]) {
    it(`EPSG:${compound} remains resolvable despite deprecation`, async () => {
      const entry = await lookupEpsgByCode(compound);
      expect(entry?.kind).toBe('Compound');
      expect(entry?.deprecated).toBe(true);
      const definition = (await lookupEpsgByCode(horizontal))?.proj4;
      expect(definition).toContain('+towgs84=');
      expect(entry?.proj4).toBe(definition);
    });
  }
});

// Exercise the generator, so a refresh cannot reintroduce the missing shift
// while the already-generated artifact still passes the lookup tests (#7658).
for (const existing of [undefined, '+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel +units=m +no_defs']) {
  it(`compound generation inherits the horizontal operation with ${existing ? 'a lossy' : 'no'} compound export (#7658)`, async () => {
    // EPSG Registry CompoundCoordRefSystem/5834, reduced to identity + relation.
    const compound = summarizeEntry({ Code: 5834, Name: 'DB_REF GK4 + DHHN92', Deprecated: true }, {
      Code: 5834, Name: 'DB_REF GK4 + DHHN92', Kind: 'compound', HorizontalCrs: { Code: 5684 },
    });
    compound.proj4 = existing;
    const horizontal = await lookupEpsgByCode('5684');
    expect(horizontal).toBeDefined();
    inheritCompoundProj4([compound], [horizontal!]);
    expect(compound.proj4).toBeTruthy();
    const [lon, lat] = proj4(compound.proj4!, 'WGS84', [4_468_005, 5_334_600]);
    // Independent PROJ 9.8.1 oracle, not a projection round-trip.
    expect(lon).toBeCloseTo(11.568577311077236, 6);
    expect(lat).toBeCloseTo(48.148613762260, 6);
  });
}

// A full regeneration inherits every compound's horizontal proj4. Codes the
// override table pins (the DB_REF2003/2016 compounds) must keep the pinned
// string, or the next refresh silently drops their +vunits (#8185 review).
it('compound inheritance leaves PROJ4_OVERRIDES codes pinned', () => {
  const [code, pinned] = [...PROJ4_OVERRIDES].find(([key]) => key === '9930')!;
  const compound = summarizeEntry({ Code: 9930, Name: 'DB_REF2003 GK4 + DHHN2016' }, {
    Code: 9930, Name: 'DB_REF2003 GK4 + DHHN2016', Kind: 'compound', HorizontalCrs: { Code: 5684 },
  });
  compound.proj4 = pinned;
  inheritCompoundProj4([compound], [{ ...compound, code: '5684', kind: 'Projected', proj4: '+proj=tmerc +other' }]);
  expect(compound.code).toBe(code);
  expect(compound.proj4).toBe(pinned);
});
