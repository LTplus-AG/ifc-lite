#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opt-in live smoke test against the real services. Never run by CI.
 *
 *   pnpm --filter @ifc-lite/flood-check build
 *   node packages/flood-check/scripts/live-smoke.mjs [easting northing]
 *
 * Makes two or three small requests: one WMS GetMap of the BAFU layer over a
 * ~30 x 20 m box (about 3 KB to 10 KB), one point height from the
 * geo.admin.ch height service at the box centre, used as flat terrain, and,
 * only when the GetMap answer is wholly transparent, the provider's 9 x 9 px
 * rendering check at its reference location. A synthetic 20 m x 10 m building
 * with one door per façade, thresholds 5 cm above that terrain, is then
 * checked and the numbers are printed. The height service states no accuracy,
 * so no door can come out above the mapped class range.
 */

import { BAFU_CLASSES, checkFloodExposure, createBafuRunoffProvider } from '../dist/index.js';
// The shipped rule for when to ask for a rendering check (runFloodCheck uses it), so this script cannot drift from it.
import { rasterShowsNoClass } from '../dist/check/layer.js';

const [e = 2_599_587, n = 1_199_753] = process.argv.slice(2).map(Number);

const heightUrl = `https://api3.geo.admin.ch/rest/services/height?easting=${e}&northing=${n}&sr=2056`;
const heightResponse = await fetch(heightUrl);
if (!heightResponse.ok) throw new Error(`height service answered HTTP ${heightResponse.status}`);
const terrainHeight = Number((await heightResponse.json()).height);

const ring = [
  { x: e - 10, y: n - 5 },
  { x: e + 10, y: n - 5 },
  { x: e + 10, y: n + 5 },
  { x: e - 10, y: n + 5 },
];
const door = (expressId, name, x, y) => ({
  expressId,
  globalId: null,
  name,
  ifcClass: 'IfcDoor',
  predefinedType: 'DOOR',
  category: 'door',
  position: { x, y },
  level: terrainHeight + 0.05,
  levelBasis: 'given',
  levelIsUpperEstimate: false,
  storeyId: null,
  selectedBecause: 'synthetic',
});
const facts = {
  georeference: {
    crs: 'EPSG:2056',
    verticalDatum: null,
    source: 'mapConversion',
    eastings: e,
    northings: n,
    orthogonalHeight: terrainHeight,
    rotationDegrees: 0,
    horizontalScale: 1,
    scaleBasis: 'units-agree',
    lengthUnitScale: 1,
  },
  footprint: { rings: [ring], source: 'given', fromElements: [] },
  storeys: [],
  groundStorey: { expressId: null, level: terrainHeight, basis: 'none' },
  candidates: [
    door(1, 'south', e, n - 5),
    door(2, 'east', e + 10, n),
    door(3, 'north', e, n + 5),
    door(4, 'west', e - 10, n),
  ],
  spaces: [],
  skipped: [],
  warnings: [],
};

const provider = createBafuRunoffProvider();
const raster = await provider.fetchRaster({
  bbox: { minX: e - 15, minY: n - 10, maxX: e + 15, maxY: n + 10 },
  crs: 'EPSG:2056',
});
// The height service's vertical frame is taken to be LN02 (swisstopo heights); this script does not verify it.
const terrain = { crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', verticalReference: 'LN02', heightAt: () => terrainHeight };
const renderingConfirmation = rasterShowsNoClass(raster) ? await provider.confirmRendering() : undefined;
// The raster carries its own coverage (`covers`); there is no coverage option any more.
const result = checkFloodExposure(facts, raster, terrain, { renderingConfirmation });

console.log(JSON.stringify({
  request: raster.provenance.requestUrl,
  retrievedAt: raster.provenance.retrievedAt,
  raster: { width: raster.width, height: raster.height, cellSize: raster.cellSize, counts: raster.counts },
  terrain: { source: heightUrl, height: terrainHeight },
  doors: result.results.map((r) => ({
    name: r.candidate.name,
    outcome: r.outcome,
    reason: r.unclassifiedReason,
    class: r.hazardClass?.id ?? null,
    level: Number(r.candidate.level.toFixed(3)),
    samples: r.samples.byReading,
    levelAboveSurfaceLowerBound: r.comparison ? Number(r.comparison.levelAboveSurfaceLowerBound.toFixed(3)) : null,
  })),
  summary: result.summary,
  layerCheck: result.layerCheck,
  heightPlausibility: result.heightPlausibility.statement,
  margin: result.margin.statement,
  classes: BAFU_CLASSES.map((c) => c.id),
}, null, 2));
