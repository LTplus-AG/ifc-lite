/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The thresholds, pinned on both sides from pure facts: each detector fires
 * just past its documented limit and stays quiet just inside it.
 */

import { describe, expect, it } from 'vitest';
import { crsRequirements, diagnoseGeoreference } from './diagnose.js';
import { AREA_OF_USE_MARGIN_DEGREES } from './area.js';
import { DOUBLE_GEOREF_RADIUS_METRES, UNIT_MISMATCH_MIN_UNIT_RATIO } from './position.js';
import { FALSE_ORIGIN_RADIUS_METRES, SITE_CONTRADICTION_KM } from './detectors/site.js';
import { SOURCE_SCALE_RELATIVE_TOLERANCE } from './detectors/consistency.js';
import { UNEXPLAINED_SCALE_BAND } from './detectors/units.js';
import { UNDECLARED_UNIT_SMALLEST_READING } from './detectors/presence.js';
import { TRUE_NORTH_TOLERANCE_DEGREES, UNIT_LENGTH_TOLERANCE } from './detectors/rotation.js';
import type { CrsFact, DiagnoseOptions, GeorefFacts, GeorefFindingCode, OperationFact, Reprojector } from './types.js';

function facts(overrides: Partial<GeorefFacts> = {}, op: Partial<OperationFact> = {}): GeorefFacts {
  return {
    schemaVersion: 'IFC4',
    lengthUnitScale: 0.001,
    lengthUnitDeclared: true,
    entities: {
      operation: { source: 'IfcMapConversion', entityId: 20, eastings: 2_600_000, northings: 1_200_000, orthogonalHeight: 540, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 0.001, ...op },
      crs: { source: 'IfcProjectedCRS', entityId: 21, name: 'EPSG:2056', verticalDatum: 'EPSG:5728', mapUnit: 'METRE', mapUnitScale: 1 },
    },
    coordinates: { siteOrigin: { x: 0, y: 0, z: 0 }, sitePlacementId: 5, sampledPoints: 4, geometry: { cartesianPoints: { median: { x: 5000, y: 4000, z: 0 }, p90Horizontal: 7000, sampled: 4 } } },
    ...overrides,
  };
}

const run = (f: GeorefFacts, options?: DiagnoseOptions) => diagnoseGeoreference(f, options);
const has = (f: GeorefFacts, code: GeorefFindingCode, options?: DiagnoseOptions) => run(f, options).findings.some((x) => x.code === code);

describe('baseline', () => {
  it('a correct model has no findings', () => {
    expect(run(facts()).findings).toEqual([]);
    expect(run(facts()).level).toBe(50);
  });
});

describe('MAP_POSITION_APPLIED_TWICE', () => {
  const siteAt = (dxMetres: number) => facts({ coordinates: { siteOrigin: { x: (2_600_000 + dxMetres) * 1000, y: 1_200_000 * 1000, z: 0 }, sampledPoints: 0 } });
  it(`fires inside ${DOUBLE_GEOREF_RADIUS_METRES} m of the anchor, not beyond`, () => {
    expect(has(siteAt(DOUBLE_GEOREF_RADIUS_METRES - 1), 'MAP_POSITION_APPLIED_TWICE')).toBe(true);
    expect(has(siteAt(DOUBLE_GEOREF_RADIUS_METRES + 1), 'MAP_POSITION_APPLIED_TWICE')).toBe(false);
  });
  it('never fires for an anchor closer than 100 km to the origin', () => {
    const near = facts({ coordinates: { siteOrigin: { x: 50_000_000, y: 0, z: 0 }, sampledPoints: 0 } }, { eastings: 50_000, northings: 0 });
    expect(has(near, 'MAP_POSITION_APPLIED_TWICE')).toBe(false);
  });
  it('a conversion with zero offsets over absolute coordinates is valid', () => {
    const absolute = facts({ coordinates: { siteOrigin: { x: 2_600_000_000, y: 1_200_000_000, z: 0 }, sampledPoints: 0 } }, { eastings: 0, northings: 0 });
    expect(run(absolute).findings).toEqual([]);
  });
});

describe('scale', () => {
  it('Scale 1000 in a millimetre project is an explained unit slip (error)', () => {
    const [f] = run(facts({}, { scale: 1000 })).findings;
    expect([f.code, f.severity, f.evidence.explanation]).toEqual(['SCALE_UNIT_MISMATCH', 'error', 'a factor of 1000000']);
  });
  it('a grid scale factor near 1 is not a slip', () => {
    expect(run(facts({}, { scale: 0.001 * 0.9996 })).findings).toEqual([]);
    expect(run(facts({}, { scale: 0.001 * 1.04 })).findings).toEqual([]);
  });
  it('an off-1 ratio no unit explains is a warning only outside [0.5, 2]', () => {
    expect(has(facts({}, { scale: 0.001 * 1.5 }), 'SCALE_UNIT_MISMATCH')).toBe(false);
    const [f] = run(facts({}, { scale: 0.001 * 3 })).findings;
    expect([f.code, f.severity]).toEqual(['SCALE_UNIT_MISMATCH', 'warning']);
  });
  it('feet read as metres is recognised', () => {
    const feet = facts({ lengthUnitScale: 0.3048 }, { scale: 1 });
    expect(run(feet).findings.map((f) => f.code)).toEqual(['SCALE_DOES_NOT_BRIDGE_UNITS']);
    const [f] = run(facts({ lengthUnitScale: 1 }, { scale: 0.3048 })).findings;
    expect(f.evidence.explanation).toBe('metres read as feet');
  });
  it('a rigid operation has no Scale to check', () => {
    expect(has(facts({}, { source: 'IfcRigidOperation', scale: undefined }), 'SCALE_DOES_NOT_BRIDGE_UNITS')).toBe(false);
  });
});

describe('MAP_UNIT_MISSING', () => {
  const noUnit = (lengthUnitScale: number) => {
    const f = facts({ lengthUnitScale }, { scale: lengthUnitScale });
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, mapUnit: undefined, mapUnitScale: undefined };
    return f;
  };
  it('is a warning when the two readings differ, info when they agree', () => {
    expect(run(noUnit(0.001)).findings.find((f) => f.code === 'MAP_UNIT_MISSING')?.severity).toBe('warning');
    expect(run(noUnit(1)).findings.find((f) => f.code === 'MAP_UNIT_MISSING')?.severity).toBe('info');
  });
  it('an area check needs the position outside under every reading', () => {
    // Eastings in millimetres would be outside LV95 read as metres but inside read in the project unit.
    const f = noUnit(0.001);
    if (f.entities?.operation) f.entities.operation = { ...f.entities.operation, eastings: 2_600_000_000, northings: 1_200_000_000 };
    expect(has(f, 'OUTSIDE_CRS_AREA')).toBe(false);
  });
});

describe('zone prefix', () => {
  const utm = (eastings: number, code = 'EPSG:25832') => {
    const f = facts({ lengthUnitScale: 1 }, { eastings, northings: 5_481_000, scale: 1 });
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, name: code };
    return f;
  };
  it('fires only when the leading digits ARE the zone and the rest is a valid easting', () => {
    expect(has(utm(32_461_000), 'EASTING_ZONE_PREFIX')).toBe(true);
    expect(has(utm(33_461_000), 'EASTING_ZONE_PREFIX')).toBe(false); // zone 33 digits in a zone 32 CRS: just outside
    expect(has(utm(32_950_000), 'EASTING_ZONE_PREFIX')).toBe(false); // remainder past 900 km
    expect(has(utm(461_000), 'EASTING_ZONE_PREFIX')).toBe(false);
  });
  it('a national grid with a UTM-like projection is not a UTM zone', () => {
    expect(has(utm(32_461_000, 'EPSG:3006'), 'EASTING_ZONE_PREFIX')).toBe(false);
  });
});

describe('SITE_LOCATION_CONTRADICTS_OPERATION', () => {
  const kmNorth = (km: number) => 46.9524056 + km / 111.195;
  const flat: DiagnoseOptions = {
    reprojector: { toWgs84: (code, [e, n]) => (code === 2056 ? [7.4395833 + (e - 2_600_000) / 75_900, 46.9524056 + (n - 1_200_000) / 111_195] : undefined) },
  };
  const site = (lat: number) => facts({ siteLocation: { siteId: 3, latitude: lat, longitude: 7.4395833 } });
  it(`fires beyond ${SITE_CONTRADICTION_KM} km, not inside`, () => {
    expect(has(site(kmNorth(SITE_CONTRADICTION_KM - 0.5)), 'SITE_LOCATION_CONTRADICTS_OPERATION', flat)).toBe(false);
    expect(has(site(kmNorth(SITE_CONTRADICTION_KM + 0.5)), 'SITE_LOCATION_CONTRADICTS_OPERATION', flat)).toBe(true);
  });
  it('uses a catalogue area of use when there is no reprojector', () => {
    const options: DiagnoseOptions = { crsCatalog: { lookup: (code) => ({ code, areaOfUse: { west: 5.96, south: 45.82, east: 10.49, north: 47.81 } }) } };
    expect(has(site(42.36), 'SITE_LOCATION_CONTRADICTS_OPERATION', options)).toBe(true);
    expect(has(site(47.0), 'SITE_LOCATION_CONTRADICTS_OPERATION', options)).toBe(false);
  });
  it('a reprojector that does not know the CRS skips the check instead of guessing', () => {
    const report = run(site(10), { reprojector: { toWgs84: () => undefined } });
    expect(report.findings).toEqual([]);
    expect(report.skipped.map((s) => s.code)).toEqual(['SITE_LOCATION_CONTRADICTS_OPERATION']);
  });
});

describe('rotation', () => {
  it(`non-unit vectors fire past ${UNIT_LENGTH_TOLERANCE}`, () => {
    expect(has(facts({}, { xAxisAbscissa: 1 + UNIT_LENGTH_TOLERANCE / 2, xAxisOrdinate: 0 }), 'ROTATION_NOT_UNIT_LENGTH')).toBe(false);
    expect(has(facts({}, { xAxisAbscissa: 1 + UNIT_LENGTH_TOLERANCE * 2, xAxisOrdinate: 0 }), 'ROTATION_NOT_UNIT_LENGTH')).toBe(true);
  });
  it('a zero vector is invalid', () => {
    const [f] = run(facts({}, { xAxisAbscissa: 0, xAxisOrdinate: 0 })).findings;
    expect([f.code, f.severity]).toEqual(['ROTATION_INVALID', 'error']);
  });
  it('unset axis means no turn and is fine', () => {
    expect(run(facts({}, { xAxisAbscissa: undefined, xAxisOrdinate: undefined })).findings).toEqual([]);
  });
  it(`TrueNorth within ${TRUE_NORTH_TOLERANCE_DEGREES}° of grid north (convergence) is fine; beyond is a contradiction`, () => {
    const theta = (20 * Math.PI) / 180;
    const op = { xAxisAbscissa: Math.cos(theta), xAxisOrdinate: Math.sin(theta) };
    const northAt = (deg: number) => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
    // Grid north in the local frame sits at 90° - 20° = 70°.
    expect(has(facts({ trueNorth: northAt(70 + TRUE_NORTH_TOLERANCE_DEGREES - 1) }, op), 'TRUE_NORTH_CONTRADICTS_ROTATION')).toBe(false);
    const report = run(facts({ trueNorth: northAt(70 + TRUE_NORTH_TOLERANCE_DEGREES + 1) }, op));
    expect(report.findings.map((f) => [f.code, f.severity])).toEqual([['TRUE_NORTH_CONTRADICTS_ROTATION', 'warning']]);
  });
  it('default TrueNorth beside a real turn is only info', () => {
    const theta = (20 * Math.PI) / 180;
    const [f] = run(facts({ trueNorth: { x: 0, y: 1 } }, { xAxisAbscissa: Math.cos(theta), xAxisOrdinate: Math.sin(theta) })).findings;
    expect([f.code, f.severity]).toEqual(['TRUE_NORTH_CONTRADICTS_ROTATION', 'info']);
  });
});

describe('CRS', () => {
  it('a compound CRS needs no separate vertical datum', () => {
    const f = facts();
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, name: 'EPSG:7415', verticalDatum: undefined };
    if (f.entities?.operation) f.entities.operation = { ...f.entities.operation, eastings: 155_000, northings: 463_000 };
    expect(has(f, 'VERTICAL_DATUM_MISSING')).toBe(true);
    expect(has(f, 'VERTICAL_DATUM_MISSING', { crsCatalog: { lookup: (code) => ({ code, kind: 'compound' }) } })).toBe(false);
  });
  it('the EPSG code is read from a WKT when the Name is a label', () => {
    const f = facts();
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, name: 'CH1903+ / LV95', wellKnownText: 'PROJCS["CH1903+ / LV95",GEOGCS["CH1903+",AUTHORITY["EPSG","4150"]],AUTHORITY["EPSG","2056"]]' };
    expect(run(f).findings).toEqual([]);
  });
});

describe('presence', () => {
  it('ePSet in IFC2X3 is the convention: no IFC2X3_NO_EPSET', () => {
    const f = facts({ schemaVersion: 'IFC2X3', entities: undefined, ePSet: facts().entities });
    if (f.ePSet?.operation) f.ePSet.operation = { ...f.ePSet.operation, source: 'ePSet_MapConversion' };
    expect(run(f).findings).toEqual([]);
    expect(run(f).effectiveSource).toBe('ePSet_MapConversion');
  });
  it('a site default matches within 0.01°, not beyond', () => {
    const at = (lat: number) => facts({ entities: undefined, siteLocation: { siteId: 1, latitude: lat, longitude: -71.0598 } });
    expect(has(at(42.3584 + 0.009), 'SITE_LOCATION_DEFAULT')).toBe(true);
    expect(has(at(42.3584 + 0.02), 'SITE_LOCATION_DEFAULT')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PR #10386 review follow-ups. Each threshold is pinned just inside and just
// outside its documented limit.
// ---------------------------------------------------------------------------

describe('named thresholds, both sides (finding 13)', () => {
  it(`site area-of-use margin ${AREA_OF_USE_MARGIN_DEGREES}°`, () => {
    const options: DiagnoseOptions = { crsCatalog: { lookup: (code) => ({ code, areaOfUse: { west: 5.96, south: 45.82, east: 10.49, north: 47.81 } }) } };
    const site = (lat: number) => facts({ siteLocation: { siteId: 3, latitude: lat, longitude: 7.44 } });
    expect(has(site(47.81 + AREA_OF_USE_MARGIN_DEGREES - 0.01), 'SITE_LOCATION_CONTRADICTS_OPERATION', options)).toBe(false);
    expect(has(site(47.81 + AREA_OF_USE_MARGIN_DEGREES + 0.01), 'SITE_LOCATION_CONTRADICTS_OPERATION', options)).toBe(true);
  });

  it(`map position area-of-use margin ${AREA_OF_USE_MARGIN_DEGREES}° (same constant)`, () => {
    // EPSG:3006 has no built-in extent: catalogue area + reprojector decide.
    const reprojector: Reprojector = { toWgs84: (_code, [e, n]) => [e / 100_000, n / 100_000] };
    const at = (lon: number) => {
      const f = facts({ lengthUnitScale: 1 }, { eastings: lon * 100_000, northings: 60 * 100_000, scale: 1 });
      if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, name: 'EPSG:3006' };
      return f;
    };
    const options: DiagnoseOptions = { reprojector, crsCatalog: { lookup: (code) => ({ code, unitScale: 1, areaOfUse: { west: 10.03, south: 54.96, east: 24.17, north: 69.07 } }) } };
    expect(has(at(24.17 + AREA_OF_USE_MARGIN_DEGREES - 0.01), 'OUTSIDE_CRS_AREA', options)).toBe(false);
    expect(has(at(24.17 + AREA_OF_USE_MARGIN_DEGREES + 0.01), 'OUTSIDE_CRS_AREA', options)).toBe(true);
  });

  it(`SOURCES_DISAGREE Scale ratio ${SOURCE_SCALE_RELATIVE_TOLERANCE}`, () => {
    const withEPSet = (ePSetScale: number) => {
      const f = facts();
      const op = f.entities?.operation;
      if (op) f.ePSet = { operation: { ...op, source: 'ePSet_MapConversion', entityId: 30, scale: ePSetScale }, crs: { ...(f.entities?.crs as CrsFact), source: 'ePSet_ProjectedCRS', entityId: 31 } };
      return f;
    };
    expect(has(withEPSet(0.001 * (1 + SOURCE_SCALE_RELATIVE_TOLERANCE / 2)), 'SOURCES_DISAGREE')).toBe(false);
    expect(has(withEPSet(0.001 * (1 + SOURCE_SCALE_RELATIVE_TOLERANCE * 2)), 'SOURCES_DISAGREE')).toBe(true);
  });

  it(`unexplained Scale band [${UNEXPLAINED_SCALE_BAND.join(', ')}] on both edges`, () => {
    const [lo, hi] = UNEXPLAINED_SCALE_BAND;
    const at = (ratio: number) => has(facts({}, { scale: 0.001 * ratio }), 'SCALE_UNIT_MISMATCH');
    expect([at(lo + 0.05), at(lo - 0.05), at(hi - 0.05), at(hi + 0.05)]).toEqual([false, true, false, true]);
  });

  it(`unit-slipped anchor needs units at least ${UNIT_MISMATCH_MIN_UNIT_RATIO}x apart`, () => {
    // The site repeats the Eastings/Northings numbers in project units; map unit metre.
    const slipped = (lengthUnitScale: number) => facts(
      { lengthUnitScale, coordinates: { siteOrigin: { x: 2_600_000, y: 1_200_000, z: 0 }, sampledPoints: 0 } },
      { scale: lengthUnitScale },
    );
    const signature = (f: GeorefFacts) => run(f).findings.find((x) => x.code === 'MAP_POSITION_APPLIED_TWICE')?.evidence.signature;
    expect(signature(slipped(UNIT_MISMATCH_MIN_UNIT_RATIO * 0.95))).toBeUndefined();
    expect(signature(slipped(UNIT_MISMATCH_MIN_UNIT_RATIO))).toBe('unitMismatchedAnchor');
  });

  it('a site within the false-origin radius makes the conversion the suspect, beyond it not', () => {
    const reprojector: Reprojector = { toWgs84: (_code, [e, n]) => [e / 100_000, n / 100_000] };
    const f = (e: number) => {
      const x = facts({ lengthUnitScale: 1, siteLocation: { siteId: 3, latitude: 48.2, longitude: 16.37 } }, { eastings: e, northings: 0, scale: 1 });
      if (x.entities?.crs) x.entities.crs = { ...x.entities.crs, name: 'EPSG:3857' };
      return x;
    };
    const suspect = (e: number) => run(f(e), { reprojector }).findings.find((x) => x.code === 'SITE_LOCATION_CONTRADICTS_OPERATION')?.evidence.suspect;
    expect(suspect(FALSE_ORIGIN_RADIUS_METRES - 1)).toBe('mapConversion');
    expect(suspect(FALSE_ORIGIN_RADIUS_METRES + 200)).toBeNull();
  });
});

describe('site contradiction suspects (finding 2)', () => {
  const reprojector: Reprojector = { toWgs84: (code, [e, n]) => (code === 2056 ? [7.4395833 + (e - 2_600_000) / 75_900, 46.9524056 + (n - 1_200_000) / 111_195] : undefined) };
  it('a site at a tool default beside a plausible conversion: the site is the suspect, fixed toward the conversion', () => {
    const [f] = run(facts({ siteLocation: { siteId: 3, latitude: 42.3584, longitude: -71.0598 } }), { reprojector }).findings.filter((x) => x.code === 'SITE_LOCATION_CONTRADICTS_OPERATION');
    expect(f.evidence.suspect).toBe('siteLocation');
    expect(f.fixes[0].changes[0]).toMatchObject({ entity: 'IfcSite', attribute: 'RefLatitude' });
  });
  it('both suspect: no fix in either direction', () => {
    const both = facts({ siteLocation: { siteId: 3, latitude: 42.3584, longitude: -71.0598 } }, { eastings: 0, northings: 0 });
    if (both.entities?.crs) both.entities.crs = { ...both.entities.crs, name: 'EPSG:3857' };
    const nullIsland: Reprojector = { toWgs84: () => [0, 0] };
    const [f] = run(both, { reprojector: nullIsland }).findings.filter((x) => x.code === 'SITE_LOCATION_CONTRADICTS_OPERATION');
    expect(f.evidence.suspect).toBe('both');
    expect(f.fixes).toEqual([]);
  });
  it('a reprojector that throws is reported as skipped, with its message', () => {
    const report = run(facts({ siteLocation: { siteId: 3, latitude: 10, longitude: 7 } }), { reprojector: { toWgs84: () => { throw new Error('grid file missing'); } } });
    expect(report.skipped).toEqual([{ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: 'The reprojector failed for EPSG:2056: grid file missing' }]);
  });
  it('the reprojector receives metres, easting first (finding 14)', () => {
    const calls: Array<readonly [number, number]> = [];
    // MapUnit millimetre: the authored numbers are 1000x the metres.
    const f = facts({ siteLocation: { siteId: 3, latitude: 46.95, longitude: 7.44 } }, { eastings: 2_600_000_000, northings: 1_200_000_000, scale: 1 });
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, mapUnit: 'MILLIMETRE', mapUnitScale: 0.001 };
    run(f, { reprojector: { toWgs84: (_c, en) => { calls.push(en); return [7.44, 46.95]; } } });
    expect(calls[0]).toEqual([2_600_000, 1_200_000]);
  });
});

describe('ROTATION_INVALID only when a filled-in default is still ambiguous (finding 8)', () => {
  it.each([
    [1, undefined, false],
    [undefined, 0, false],
    [0.6, undefined, true],
    [undefined, 1, true],
  ] as const)('(%s, %s) → %s', (a, b, fires) => {
    expect(has(facts({}, { xAxisAbscissa: a, xAxisOrdinate: b }), 'ROTATION_INVALID')).toBe(fires);
  });
});

describe('a half-set axis that fills in to a unit vector is still compared with TrueNorth (review)', () => {
  // XAxisAbscissa 1 turns nothing; TrueNorth pointing along +x is 90° from grid north.
  const east = { x: 1, y: 0 };
  it.each([[1, undefined], [1, 0], [undefined, 0], [undefined, undefined]] as const)('(%s, %s) with TrueNorth (1, 0) contradicts the turn', (a, b) => {
    const codes = run(facts({ trueNorth: east }, { xAxisAbscissa: a, xAxisOrdinate: b })).findings.map((f) => f.code);
    expect(codes).toEqual(['TRUE_NORTH_CONTRADICTS_ROTATION']);
  });
});

describe('a blank CRS record is not a declared CRS for LoGeoRef 50 (review)', () => {
  it('blank Name and no WKT: error, and no level 50', () => {
    const f = facts();
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, name: '  ' };
    const report = run(f);
    expect(report.findings.map((x) => x.code)).toContain('OPERATION_WITHOUT_CRS');
    expect(report.levels).not.toContain(50);
  });
  it('the crsDeclared indicator agrees: blank is not declared, a name or a WKT is (entity and ePSet)', () => {
    const blank = facts();
    if (blank.entities?.crs) blank.entities.crs = { ...blank.entities.crs, name: ' ' };
    expect(run(blank).indicators.crsDeclared).toBe(false);
    const ePSet = facts();
    ePSet.ePSet = { crs: { source: 'ePSet_ProjectedCRS', entityId: 30, name: '' } };
    if (ePSet.entities?.crs) ePSet.entities.crs = { ...ePSet.entities.crs, name: '' };
    expect(run(ePSet).indicators.crsDeclared).toBe(false);
    expect(run(facts()).indicators.crsDeclared).toBe(true);
    ePSet.ePSet = { crs: { source: 'ePSet_ProjectedCRS', entityId: 30, name: 'EPSG:2056' } };
    expect(run(ePSet).indicators.crsDeclared).toBe(true);
  });
  it('a blank Name with a WKT definition still counts', () => {
    const f = facts();
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, name: '', wellKnownText: 'PROJCS["x",AUTHORITY["EPSG","2056"]]' };
    expect(run(f).levels).toContain(50);
  });
});

describe('SITE_LOCATION_CONTRADICTS_OPERATION needs every map-unit reading resolved (review)', () => {
  it('MapUnit unset in a millimetre project: a reading the reprojector cannot place skips instead of contradicting', () => {
    const f = facts({ siteLocation: { siteId: 3, latitude: 10, longitude: 10 } }, { eastings: 2_600_000, northings: 1_200_000, scale: 1 });
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, mapUnit: undefined, mapUnitScale: undefined };
    // Resolves only the metre reading (easting < 10 million); the millimetre reading is out of its range.
    const reprojector: Reprojector = { toWgs84: (_c, [e]) => (e > 1_000_000 && e < 3_000_000 ? [7.44, 46.95] : undefined) };
    const report = run(f, { reprojector });
    expect(report.findings.map((x) => x.code)).not.toContain('SITE_LOCATION_CONTRADICTS_OPERATION');
    expect(report.skipped.map((s) => s.code)).toContain('SITE_LOCATION_CONTRADICTS_OPERATION');
  });
});

describe('VERTICAL_DATUM_MISSING examples follow the CRS (finding 10)', () => {
  const message = (name: string, e: number, n: number) => {
    const f = facts({ lengthUnitScale: 1 }, { eastings: e, northings: n, scale: 1 });
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, name, verticalDatum: undefined };
    return run(f).findings.find((x) => x.code === 'VERTICAL_DATUM_MISSING')?.message ?? '';
  };
  it('Swiss grid: the Swiss height systems', () => {
    expect(message('EPSG:2056', 2_600_000, 1_200_000)).toMatch(/LN02/);
  });
  it('New Zealand and a multi-country UTM zone: no example', () => {
    for (const m of [message('EPSG:2193', 1_750_000, 5_920_000), message('EPSG:25832', 461_000, 5_481_000)]) {
      expect(m).not.toMatch(/LN02|DHHN|NAP/);
      expect(m).toMatch(/EPSG code of the height system/);
    }
  });
});

describe('levels per the published definition (finding 7)', () => {
  it('LoGeoRef 30 is any location in a root spatial placement, no distance rule', () => {
    const near = facts({ rootSpatialPlacements: [{ elementId: 3, elementType: 'IfcSite', location: { x: 500, y: 0, z: 0 }, rotated: false }] });
    expect(run(near).levels).toContain(30);
    expect(run(near).indicators.placementAtMapMagnitude).toBe(false);
    const turned = facts({ rootSpatialPlacements: [{ elementId: 3, elementType: 'IfcSite', location: { x: 0, y: 0, z: 0 }, rotated: true }] });
    expect(run(turned).levels).toContain(30);
    const atOrigin = facts({ rootSpatialPlacements: [{ elementId: 3, elementType: 'IfcSite', location: { x: 0, y: 0, z: 0 }, rotated: false }] });
    expect(run(atOrigin).levels).not.toContain(30);
  });
  it('an IFC2X3 ePSet is not LoGeoRef 50, and is reported as the convention', () => {
    const f = facts({ schemaVersion: 'IFC2X3', entities: undefined, ePSet: facts().entities });
    if (f.ePSet?.operation) f.ePSet.operation = { ...f.ePSet.operation, source: 'ePSet_MapConversion' };
    const report = run(f);
    expect(report.levels).not.toContain(50);
    expect(report.indicators.ePSetConvention).toBe(true);
  });
  it('an IfcRigidOperation is not an IfcMapConversion: no 50, indicator set', () => {
    const report = run(facts({ schemaVersion: 'IFC4X3_ADD2' }, { source: 'IfcRigidOperation', scale: undefined }));
    expect(report.levels).not.toContain(50);
    expect(report.indicators.rigidOperation).toBe(true);
  });
  it('an IFC4 IfcMapConversion onto a CRS is 50', () => {
    expect(run(facts()).levels).toContain(50);
  });
});

describe('crsRequirements (finding 14)', () => {
  it('lists the EPSG code, name and WKT the diagnosis will reproject from', () => {
    const f = facts();
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, wellKnownText: 'PROJCS["CH1903+ / LV95",AUTHORITY["EPSG","2056"]]' };
    expect(crsRequirements(f)).toEqual([{ epsg: 2056, name: 'EPSG:2056', wkt: 'PROJCS["CH1903+ / LV95",AUTHORITY["EPSG","2056"]]' }]);
  });
  it('resolves a CRS written by name through the same catalogue, and is empty without an operation', () => {
    const f = facts();
    if (f.entities?.crs) f.entities.crs = { ...f.entities.crs, name: 'CH1903+ / LV95' };
    expect(crsRequirements(f)).toEqual([]);
    expect(crsRequirements(f, { crsCatalog: { lookup: () => undefined, resolveName: () => 2056 } })).toEqual([{ epsg: 2056, name: 'CH1903+ / LV95' }]);
    expect(crsRequirements(facts({ entities: undefined }))).toEqual([]);
  });
});

describe('CRS_WITHOUT_OPERATION (bot review a)', () => {
  it('a CRS alone is a finding, not silence', () => {
    const f = facts({ entities: { crs: facts().entities?.crs } });
    expect(run(f).findings.map((x) => x.code)).toEqual(['CRS_WITHOUT_OPERATION']);
    expect(run(f).level).toBe(0);
  });
});

describe('a blank CRS and the unit of a new conversion (review round 2)', () => {
  it('a blank-Name CRS with nothing else reads as no georeferencing, and the fix names the CRS', () => {
    const blank = facts({ entities: { crs: { ...(facts().entities?.crs as CrsFact), name: '  ', mapUnit: undefined, mapUnitScale: undefined } } });
    const report = run(blank);
    const codes = report.findings.map((x) => x.code);
    expect(codes).toContain('NO_GEOREFERENCE');
    expect(codes).not.toContain('CRS_WITHOUT_OPERATION');
    const changes = report.findings.find((x) => x.code === 'NO_GEOREFERENCE')?.fixes[0].changes;
    expect(changes).toContainEqual({ entity: 'IfcProjectedCRS', entityId: 21, attribute: 'Name', value: null });
  });
  it('a metre CRS beside a millimetre project: the new conversion carries Scale 0.001', () => {
    const f = facts({ entities: { crs: facts().entities?.crs } });
    const [finding] = run(f).findings;
    expect(finding.code).toBe('CRS_WITHOUT_OPERATION');
    expect(finding.fixes[0].changes).toContainEqual({ entity: 'IfcMapConversion', attribute: 'Scale', value: 0.001 });
    expect(finding.fixes[0].apply).toMatchObject({ via: 'georef.update', input: { MapConversion: { Scale: 0.001 } } });
  });
  it('a metre project with a metre CRS needs no Scale', () => {
    const f = facts({ lengthUnitScale: 1, entities: { crs: facts().entities?.crs } });
    const [finding] = run(f).findings;
    expect(finding.fixes[0].changes.some((c) => c.attribute === 'Scale')).toBe(false);
  });
});

describe('an undeclared length unit (sweep: a MagiCAD fragment with no IfcUnitAssignment)', () => {
  const placed = (x: number, lengthUnitDeclared: boolean) => facts({
    entities: undefined, lengthUnitScale: 1, lengthUnitDeclared,
    coordinates: { siteOrigin: { x: 0, y: 0, z: 0 }, sampledPoints: 2, geometry: { cartesianPoints: { median: { x, y: 0, z: 0 }, p90Horizontal: x, sampled: 2 } } },
  });
  it(`map magnitude must hold under the ${UNDECLARED_UNIT_SMALLEST_READING} m reading too`, () => {
    expect(has(placed(150_000, true), 'MAP_COORDINATES_IN_PLACEMENTS')).toBe(true);
    expect(has(placed(150_000, false), 'MAP_COORDINATES_IN_PLACEMENTS')).toBe(false);
    expect(has(placed(150_000_000, false), 'MAP_COORDINATES_IN_PLACEMENTS')).toBe(true);
  });
});
