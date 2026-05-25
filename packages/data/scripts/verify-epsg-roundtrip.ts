#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Verify the bundled EPSG index against a curated set of control points.
 *
 * For each fixture in `scripts/fixtures/epsg-control-points.json`:
 *   1. Look up the bundled proj4 definition for the EPSG code.
 *   2. Reproject the published (easting, northing) → (lon, lat).
 *   3. Reproject (lon, lat) → (easting', northing') as a round-trip check.
 *   4. Compare against the published WGS84 lat/lon. Pass if within `tolerance_m`.
 *
 * Use this script after regenerating the EPSG index to catch silent drift
 * (e.g. epsg.io changing its proj4 output, a CRS losing its +towgs84, etc).
 *
 * Usage:
 *   npx tsx scripts/verify-epsg-roundtrip.ts
 *   pnpm verify:epsg
 *
 * Exit codes:
 *   0 — all fixtures pass
 *   1 — one or more fixtures fail, OR the EPSG index couldn't be loaded
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';
// Import the TypeScript source directly so this script runs without a build
// step. The `.js` suffix in the source matches NodeNext ESM resolution.
import { lookupEpsgByCode, loadEpsgIndexDatasetVersion } from '../src/epsg-index.js';

/**
 * Mirror the datum-shift fallback the viewer applies at runtime in
 * `apps/viewer/src/lib/geo/reproject.ts`. The bundled proj4 for some CRSs
 * (e.g. EPSG:27700 / OSGB36) references browser-unavailable grid files —
 * those need to be stripped and replaced with a +towgs84 approximation
 * before proj4js can run them. Keep this table in sync with reproject.ts.
 */
const DATUM_TOWGS84_FALLBACK: Record<string, string> = {
  'osgb 1936': '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489',
  'north american datum 1927': '+towgs84=-8,160,176,0,0,0,0',
  'nad27': '+towgs84=-8,160,176,0,0,0,0',
  'north american datum 1983': '+towgs84=0,0,0,0,0,0,0',
  'nad83': '+towgs84=0,0,0,0,0,0,0',
  'deutsches hauptdreiecksnetz': '+towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7',
  'dhdn': '+towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7',
  'amersfoort': '+towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725',
  'militar-geographische institut': '+towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232',
  'mgi': '+towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232',
  'system of the unified trigonometrical cadastral network': '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56',
  's-jtsk': '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56',
  'new zealand geodetic datum 1949': '+towgs84=59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993',
  'nzgd49': '+towgs84=59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993',
  'australian geodetic datum 1984': '+towgs84=-117.763,-51.51,139.061,0.292,0.443,0.277,-0.191',
  'agd84': '+towgs84=-117.763,-51.51,139.061,0.292,0.443,0.277,-0.191',
};

function sanitizeBundledProj4(def: string, datumName?: string | null): string {
  if (!def.includes('+nadgrids') || def.includes('+nadgrids=@null')) return def;
  if (/\+towgs84=/.test(def)) {
    return def.replace(/\+nadgrids=\S+/g, '').replace(/\s+/g, ' ').trim();
  }
  const datumKey = datumName?.trim().toLowerCase() ?? '';
  const towgs84 = datumKey ? DATUM_TOWGS84_FALLBACK[datumKey] : undefined;
  if (!towgs84) {
    return def.replace(/\+nadgrids=\S+/g, '').replace(/\s+/g, ' ').trim();
  }
  return def.replace(/\+nadgrids=\S+/g, '').replace(/\s+/g, ' ').trim() + ' ' + towgs84;
}

interface ControlPointFixture {
  epsg: string;
  name: string;
  control_point: {
    description: string;
    projected: { easting: number; northing: number };
    expected_wgs84: { lat: number; lon: number };
  };
  tolerance_m: number;
}

interface FixturesFile {
  fixtures: ControlPointFixture[];
}

const FIXTURES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/epsg-control-points.json',
);

function loadFixtures(): ControlPointFixture[] {
  const raw = fs.readFileSync(FIXTURES_PATH, 'utf8');
  const parsed = JSON.parse(raw) as FixturesFile;
  if (!Array.isArray(parsed.fixtures)) {
    throw new Error('epsg-control-points.json must contain a `fixtures` array');
  }
  return parsed.fixtures;
}

/**
 * Approximate metres-per-degree at the given latitude. Used to convert
 * WGS84 lat/lon residuals to a metric distance for tolerance checks.
 * Sphere model is sufficient for tolerance checks; the WGS84 ellipsoid
 * correction is well below the ~1-10m tolerances the fixtures use.
 */
function degreesToMeters(latDeg: number, lonDeg: number, atLatDeg: number): number {
  const latRad = (atLatDeg * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos(latRad);
  return Math.sqrt((latDeg * mPerDegLat) ** 2 + (lonDeg * mPerDegLon) ** 2);
}

interface FixtureResult {
  fixture: ControlPointFixture;
  pass: boolean;
  forwardErrorM: number | null;
  roundTripErrorM: number | null;
  reason?: string;
}

async function verifyFixture(fixture: ControlPointFixture): Promise<FixtureResult> {
  const entry = await lookupEpsgByCode(fixture.epsg);
  if (!entry) {
    return {
      fixture,
      pass: false,
      forwardErrorM: null,
      roundTripErrorM: null,
      reason: `EPSG:${fixture.epsg} not present in the bundled index`,
    };
  }
  if (!entry.proj4) {
    return {
      fixture,
      pass: false,
      forwardErrorM: null,
      roundTripErrorM: null,
      reason: `EPSG:${fixture.epsg} has no proj4 string in the bundled index`,
    };
  }

  const projDef = sanitizeBundledProj4(entry.proj4, entry.datum);
  const isGeographic = /\+proj=longlat\b/.test(projDef);

  // Forward: projected → WGS84
  let lonForward: number;
  let latForward: number;
  try {
    if (isGeographic) {
      lonForward = fixture.control_point.projected.easting;
      latForward = fixture.control_point.projected.northing;
    } else {
      const result = proj4(projDef, 'WGS84', [
        fixture.control_point.projected.easting,
        fixture.control_point.projected.northing,
      ]);
      lonForward = result[0];
      latForward = result[1];
    }
  } catch (error) {
    return {
      fixture,
      pass: false,
      forwardErrorM: null,
      roundTripErrorM: null,
      reason: `proj4 forward transform threw: ${(error as Error).message}`,
    };
  }

  const forwardLatErr = latForward - fixture.control_point.expected_wgs84.lat;
  const forwardLonErr = lonForward - fixture.control_point.expected_wgs84.lon;
  const forwardErrorM = degreesToMeters(
    forwardLatErr,
    forwardLonErr,
    fixture.control_point.expected_wgs84.lat,
  );

  // Round trip: WGS84 → projected
  let eastingRT: number;
  let northingRT: number;
  try {
    if (isGeographic) {
      eastingRT = lonForward;
      northingRT = latForward;
    } else {
      const result = proj4('WGS84', projDef, [lonForward, latForward]);
      eastingRT = result[0];
      northingRT = result[1];
    }
  } catch (error) {
    return {
      fixture,
      pass: false,
      forwardErrorM,
      roundTripErrorM: null,
      reason: `proj4 inverse transform threw: ${(error as Error).message}`,
    };
  }

  const roundTripEastErr = eastingRT - fixture.control_point.projected.easting;
  const roundTripNorthErr = northingRT - fixture.control_point.projected.northing;
  const roundTripErrorM = Math.sqrt(roundTripEastErr ** 2 + roundTripNorthErr ** 2);

  const pass = forwardErrorM <= fixture.tolerance_m && roundTripErrorM <= fixture.tolerance_m;

  return {
    fixture,
    pass,
    forwardErrorM,
    roundTripErrorM,
    reason: pass
      ? undefined
      : `forward error ${forwardErrorM.toFixed(2)}m / round-trip ${roundTripErrorM.toFixed(2)}m exceeds tolerance ${fixture.tolerance_m}m`,
  };
}

function formatRow(result: FixtureResult): string {
  const status = result.pass ? '✓ PASS' : '✗ FAIL';
  const fwd = result.forwardErrorM == null ? '   -   ' : `${result.forwardErrorM.toFixed(2).padStart(7)}m`;
  const rt = result.roundTripErrorM == null ? '   -   ' : `${result.roundTripErrorM.toFixed(2).padStart(7)}m`;
  const code = `EPSG:${result.fixture.epsg}`.padEnd(11);
  const tol = `±${result.fixture.tolerance_m}m`.padStart(6);
  const name = result.fixture.name;
  return `  ${status}  ${code} ${tol}  fwd=${fwd}  rt=${rt}  ${name}`;
}

async function main(): Promise<number> {
  const fixtures = loadFixtures();
  const datasetVersion = await loadEpsgIndexDatasetVersion().catch((error) => {
    console.warn('[verify:epsg] failed to read EPSG index dataset version:', error);
    return 'unknown';
  });
  console.log(`Verifying ${fixtures.length} EPSG control points against bundled index v${datasetVersion}`);
  console.log('');

  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    results.push(await verifyFixture(fixture));
  }

  for (const result of results) {
    console.log(formatRow(result));
    if (result.reason && !result.pass) {
      console.log(`        → ${result.reason}`);
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log('');
  if (failed.length === 0) {
    console.log(`All ${results.length} fixtures passed.`);
    return 0;
  }
  console.log(`${failed.length}/${results.length} fixture(s) failed:`);
  for (const failure of failed) {
    console.log(`  - EPSG:${failure.fixture.epsg} (${failure.fixture.name})`);
  }
  return 1;
}

process.exitCode = await main();
