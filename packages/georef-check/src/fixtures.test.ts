/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End to end through the real columnar parser: every synthetic fixture in
 * `fixtures/` triggers exactly its finding (and nothing else), and every
 * clean fixture triggers nothing. The reprojector is a local linear stub
 * around Bern, enough to tell 150 m from 2,000 km.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { collectGeorefFacts } from './facts-from-store.js';
import { diagnoseGeoreference } from './diagnose.js';
import type { CrsCatalog, DiagnoseOptions, GeorefFacts, GeorefReport, Reprojector } from './types.js';

const FIXTURES = new URL('../fixtures/', import.meta.url);

/**
 * Metres → WGS84 [lon, lat]: LV95 linearised around Bern (a few hundred
 * metres off), EPSG:3857 exactly (spherical Mercator has a closed form);
 * undefined for any other CRS.
 */
const lv95Stub: Reprojector = {
  toWgs84(code, [easting, northing]) {
    if (code === 3857) {
      const R = 6_378_137;
      return [(easting / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(northing / R)) - Math.PI / 2) * (180 / Math.PI)];
    }
    if (code !== 2056) return undefined;
    const latitude = 46.9524056 + (northing - 1_200_000) / 111_195;
    return [7.4395833 + (easting - 2_600_000) / (111_195 * Math.cos((latitude * Math.PI) / 180)), latitude];
  },
};

const catalogStub: CrsCatalog = {
  lookup: (code) => (code === 3006
    ? { code, kind: 'projected', unitScale: 1, areaOfUse: { west: 10.03, south: 54.96, east: 24.17, north: 69.07 } }
    : undefined),
  resolveName: (name) => (name === 'CH1903+ / LV95' ? 2056 : undefined),
};

const OPTIONS: DiagnoseOptions = { reprojector: lv95Stub, crsCatalog: catalogStub };

async function factsOf(name: string): Promise<GeorefFacts> {
  // A copy, not `readFileSync(...).buffer`: small files share Node's buffer
  // pool, and the parser would read the neighbouring bytes too.
  const bytes = new Uint8Array(readFileSync(new URL(`${name}.ifc`, FIXTURES)));
  const store = await new IfcParser().parseColumnar(bytes.buffer);
  const facts = collectGeorefFacts(store);
  if (!facts) throw new Error(`${name}: no STEP source`);
  return facts;
}

async function diagnose(name: string, options: DiagnoseOptions = OPTIONS): Promise<GeorefReport> {
  return diagnoseGeoreference(await factsOf(name), options);
}

const codes = (report: GeorefReport) => report.findings.map((f) => `${f.severity}:${f.code}`).sort();

/** Fixture → exactly the findings it must produce (severity:code). */
const EXPECTED: Record<string, string[]> = {
  'clean-lv95-mm': [],
  'clean-lv95-rotated': [],
  'clean-zone-prefixed-crs': [],
  'clean-ifc2x3-epset': [],
  'control-terrain-epsg3006': [],
  'no-georef': ['warning:NO_GEOREFERENCE'],
  'site-only': ['warning:SITE_LOCATION_ONLY'],
  'site-default-revit-boston': ['warning:SITE_LOCATION_DEFAULT', 'warning:SITE_LOCATION_ONLY'],
  'site-null-island': ['warning:SITE_LOCATION_DEFAULT', 'warning:SITE_LOCATION_ONLY'],
  'site-contradicts-conversion': ['warning:SITE_LOCATION_CONTRADICTS_OPERATION'],
  'site-latlong-swapped': ['warning:SITE_LOCATION_CONTRADICTS_OPERATION'],
  'double-site-placement': ['error:MAP_POSITION_APPLIED_TWICE'],
  'double-site-unit-slip': ['error:MAP_POSITION_APPLIED_TWICE'],
  'double-geometry': ['error:MAP_POSITION_APPLIED_TWICE'],
  'map-coordinates-in-placements': ['warning:MAP_COORDINATES_IN_PLACEMENTS'],
  'scale-inverted': ['error:SCALE_UNIT_MISMATCH'],
  'scale-unset-mm': ['warning:SCALE_DOES_NOT_BRIDGE_UNITS'],
  'scale-zero': ['error:SCALE_INVALID'],
  'zone-prefix': ['error:EASTING_ZONE_PREFIX'],
  'zone-prefix-missing': ['error:EASTING_ZONE_PREFIX_MISSING'],
  'lv03-numbers-in-lv95': ['error:LV03_LV95_MIX'],
  'outside-area-kilometres': ['error:OUTSIDE_CRS_AREA'],
  'outside-area-swapped': ['error:OUTSIDE_CRS_AREA'],
  'crs-name-only': ['info:CRS_NOT_RESOLVABLE'],
  'operation-without-crs': ['error:OPERATION_WITHOUT_CRS'],
  'rigid-operation-without-crs': ['error:OPERATION_WITHOUT_CRS'],
  'map-unit-missing-mm': ['warning:MAP_UNIT_MISSING'],
  'vertical-datum-missing': ['info:VERTICAL_DATUM_MISSING'],
  'rotation-not-unit': ['warning:ROTATION_NOT_UNIT_LENGTH'],
  'rotation-only-abscissa': ['warning:ROTATION_INVALID'],
  'true-north-reversed': ['warning:TRUE_NORTH_CONTRADICTS_ROTATION'],
  'height-in-millimetres': ['warning:ORTHOGONAL_HEIGHT_IMPLAUSIBLE'],
  'sources-disagree': ['warning:SOURCES_DISAGREE'],
  'two-map-conversions': ['warning:SOURCES_DISAGREE'],
  'ifc2x3-site-only': ['info:IFC2X3_NO_EPSET'],
  // PR #10386 review, finding 1: 200 local IfcCartesianPoint beside 3 point
  // lists in LV95. Pooled, the local points outvoted the lists: a false
  // OUTSIDE_CRS_AREA on the correct file, nothing on the doubled one.
  'mixed-families-zero-offset': [],
  'mixed-families-double': ['error:MAP_POSITION_APPLIED_TWICE'],
  // Finding 5a: a CRS alone places nothing.
  'crs-only': ['warning:CRS_WITHOUT_OPERATION'],
  // Finding 5b: same offsets, different TargetCRS.
  'two-map-conversions-crs': ['warning:SOURCES_DISAGREE'],
  // Finding 5d: a negative FactorY on an IfcMapConversionScaled (the parser
  // reads a FactorY of exactly 0 as unset, so 0 is pinned on facts instead).
  'scaled-factor-y-negative': ['error:SCALE_INVALID'],
  // Finding 8: (1, unset) fills to (1, 0) in every reader.
  'clean-rotation-filled-default': [],
  // Finding 2: ISSUE_159's shape, a map conversion at E 0 / N 0 beside a real site.
  'site-vs-false-origin-3857': ['warning:SITE_LOCATION_CONTRADICTS_OPERATION'],
  // Finding 9: an address is not nothing.
  'no-georef-address': ['warning:NO_GEOREFERENCE'],
};

describe('fixtures through the real parser', () => {
  it('has an expectation for every fixture file', () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.ifc')).map((f) => f.replace(/\.ifc$/, '')).sort();
    expect(files).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name} → ${expected.length ? expected.join(', ') : 'no findings'}`, async () => {
      expect(codes(await diagnose(name))).toEqual([...expected].sort());
    });
  }

  it('clean fixtures stay clean with no capabilities injected, and say what they skipped', async () => {
    for (const name of ['clean-lv95-mm', 'clean-lv95-rotated', 'clean-ifc2x3-epset', 'control-terrain-epsg3006']) {
      const report = await diagnose(name, {});
      expect(codes(report), name).toEqual([]);
    }
    const lv95 = await diagnose('clean-lv95-mm', {});
    expect(lv95.skipped.map((s) => s.code)).toEqual(['SITE_LOCATION_CONTRADICTS_OPERATION']);
  });

  it('degrades to a skipped check when the site contradiction cannot be computed', async () => {
    const report = await diagnose('site-contradicts-conversion', {});
    expect(codes(report)).toEqual([]);
    expect(report.skipped).toEqual([{ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: 'No reprojector and no CRS area of use injected.' }]);
  });

  it('reports the levels of georeferencing present', async () => {
    expect((await diagnose('clean-lv95-mm')).levels).toEqual([10, 20, 50]);
    expect((await diagnose('clean-lv95-rotated')).levels).toEqual([10, 20, 40, 50]);
    expect((await diagnose('map-coordinates-in-placements')).levels).toEqual([30]);
    expect((await diagnose('double-site-placement')).levels).toEqual([10, 20, 30, 50]);
    expect((await diagnose('site-only')).level).toBe(20);
    expect((await diagnose('no-georef')).level).toBe(0);
  });

  it('measures coordinates without meshing', async () => {
    const double = await factsOf('double-site-placement');
    expect(double.coordinates?.siteOrigin).toEqual({ x: 2_600_000_000, y: 1_199_650_000, z: 0 });
    expect(double.lengthUnitScale).toBe(0.001);
    const geometry = await factsOf('double-geometry');
    expect(geometry.coordinates?.siteOrigin).toEqual({ x: 0, y: 0, z: 0 });
    expect(geometry.coordinates?.geometry?.cartesianPoints?.median.x).toBeGreaterThan(2_000_000_000);
    const terrain = await factsOf('control-terrain-epsg3006');
    // The CC0 terrain is an IfcCartesianPointList3D, sampled too (its only
    // IfcCartesianPoint is a placement Location and is left out).
    expect(terrain.coordinates?.geometry?.pointLists?.sampled).toBe(5);
    expect(terrain.coordinates?.geometry?.cartesianPoints).toBeUndefined();
  });
});

describe('suggested fixes are applicable values', () => {
  it('double map position: move the site back by the anchor, in project units', async () => {
    const [finding] = (await diagnose('double-site-placement')).findings;
    expect(finding.fixes[0].changes).toEqual([{ entity: 'IfcCartesianPoint', entityId: 10, attribute: 'Coordinates', value: [0, 0, 0] }]);
    expect(finding.fixes[0].apply.via).toBe('manual');
    expect(finding.evidence.signature).toBe('anchor');
  });

  it('unit-slipped site anchor (#9480 signature)', async () => {
    const [finding] = (await diagnose('double-site-unit-slip')).findings;
    expect(finding.evidence.signature).toBe('unitMismatchedAnchor');
    expect(finding.fixes[0].changes[0].value).toEqual([0, 0, 0]);
  });

  it('zone prefix: strip it, or declare the zE-N CRS', async () => {
    const [finding] = (await diagnose('zone-prefix')).findings;
    expect(finding.fixes.map((f) => f.changes)).toEqual([
      [{ entity: 'IfcMapConversion', entityId: expect.any(Number), attribute: 'Eastings', value: 461_000 }],
      [{ entity: 'IfcProjectedCRS', entityId: expect.any(Number), attribute: 'Name', value: 'EPSG:4647' }],
    ]);
  });

  it('LV03 numbers in LV95: declare EPSG:21781 first, shifting second', async () => {
    const [finding] = (await diagnose('lv03-numbers-in-lv95')).findings;
    expect(finding.fixes[0].changes[0]).toMatchObject({ attribute: 'Name', value: 'EPSG:21781' });
    expect(finding.fixes[1].changes.map((c) => c.value)).toEqual([2_600_000, 1_199_650]);
  });

  it('outside the area: swapped axes and kilometres are recognised', async () => {
    const [swapped] = (await diagnose('outside-area-swapped')).findings;
    expect(swapped.fixes[0].changes.map((c) => c.value)).toEqual([2_600_000, 1_199_650]);
    const [km] = (await diagnose('outside-area-kilometres')).findings;
    expect(km.fixes[0].changes.map((c) => c.value)).toEqual([461_000, 5_481_000]);
  });

  it('scale: set Scale to the unit conversion', async () => {
    const [finding] = (await diagnose('scale-inverted')).findings;
    expect(finding.fixes[0].changes).toEqual([{ entity: 'IfcMapConversion', entityId: expect.any(Number), attribute: 'Scale', value: 0.001 }]);
  });

  it('site contradiction: swapped latitude/longitude, fix from the reprojected position', async () => {
    const [finding] = (await diagnose('site-latlong-swapped')).findings;
    expect(finding.evidence.swapped).toBe(true);
    const [lat, lon] = finding.fixes[0].changes.map((c) => c.value as number);
    expect(lat).toBeCloseTo(46.949, 2);
    expect(lon).toBeCloseTo(7.4396, 3);
  });
});
