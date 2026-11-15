/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The thresholds, pinned on both sides from pure facts: each detector fires
 * just past its documented limit and stays quiet just inside it.
 */

import { describe, expect, it } from 'vitest';
import { diagnoseGeoreference } from './diagnose.js';
import { DOUBLE_GEOREF_RADIUS_METRES } from './position.js';
import { SITE_CONTRADICTION_KM } from './detectors/site.js';
import { TRUE_NORTH_TOLERANCE_DEGREES, UNIT_LENGTH_TOLERANCE } from './detectors/rotation.js';
import type { DiagnoseOptions, GeorefFacts, GeorefFindingCode, OperationFact } from './types.js';

function facts(overrides: Partial<GeorefFacts> = {}, op: Partial<OperationFact> = {}): GeorefFacts {
  return {
    schemaVersion: 'IFC4',
    lengthUnitScale: 0.001,
    lengthUnitDeclared: true,
    entities: {
      operation: { source: 'IfcMapConversion', entityId: 20, eastings: 2_600_000, northings: 1_200_000, orthogonalHeight: 540, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 0.001, ...op },
      crs: { source: 'IfcProjectedCRS', entityId: 21, name: 'EPSG:2056', verticalDatum: 'EPSG:5728', mapUnit: 'METRE', mapUnitScale: 1 },
    },
    coordinates: { siteOrigin: { x: 0, y: 0, z: 0 }, sitePlacementId: 5, sampledPoints: 4, pointMedian: { x: 5000, y: 4000, z: 0 } },
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
    reprojector: { toGeographic: (code, e, n) => (code === 2056 ? { latitude: 46.9524056 + (n - 1_200_000) / 111_195, longitude: 7.4395833 + (e - 2_600_000) / 75_900 } : undefined) },
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
    const report = run(site(10), { reprojector: { toGeographic: () => undefined } });
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
