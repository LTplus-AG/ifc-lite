/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opt-in smoke test against the LIVE Swiss services. Not run in CI.
 *
 *   pnpm --filter @ifc-lite/geodata-ch build
 *   pnpm --filter @ifc-lite/geodata-ch smoke:live
 *
 * About 60 requests at the client's default 5 requests/second per host.
 * Exits non-zero on the first failed expectation.
 */

import { createSwissGeodata, VECTOR_LAYERS } from '../dist/index.js';

const geo = createSwissGeodata();
const results = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`ok   ${name} (${Date.now() - t0} ms) ${detail}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(err) });
    console.log(`FAIL ${name}: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

let point;
let egrid;
await step('geocode "Bundesplatz 3, Bern"', async () => {
  const r = await geo.geocode('Bundesplatz 3, Bern', { limit: 3 });
  const c = r.candidates[0];
  expect(c && Math.abs(c.x - 2_600_423) < 50 && Math.abs(c.y - 1_199_521) < 50, `unexpected ${JSON.stringify(c)}`);
  point = c;
  return `${c.label} → E ${c.x.toFixed(1)} N ${c.y.toFixed(1)}`;
});

await step('parcels at the address point', async () => {
  const ps = await geo.parcelsAtPoint(point.x, point.y);
  expect(ps.length > 0, 'no parcel at point');
  egrid = ps[0].egrid;
  return ps.map((p) => `${p.egrid} ${p.canton} #${p.number} ${p.computedArea.toFixed(0)} m²`).join('; ');
});

await step('parcel by EGRID', async () => {
  const p = await geo.parcelById(egrid);
  expect(p && p.egrid === egrid && p.geometry.coordinates.length > 0, 'EGRID lookup failed');
  return `${p.egrid} ${p.geometry.type} ${p.computedArea.toFixed(1)} m², source ${p.sourceLayer}`;
});

await step('ÖREB extract for the parcel', async () => {
  const r = await geo.oerebExtract(egrid);
  expect(r && r.urls.json.startsWith('https://'), 'no extract reference');
  return `${r.source} ${r.canton} ${r.urls.json}`;
});

const box = { minX: 2_600_300, minY: 1_199_400, maxX: 2_600_700, maxY: 1_199_800 };
await step('terrain 400 m box at 2 m (2 m product)', async () => {
  const g = await geo.elevationGrid(box, { resolution: 2 });
  const vals = Array.from(g.values).filter((v) => !Number.isNaN(v));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  expect(g.noDataCount === 0 && min > 450 && max < 600, `implausible heights ${min}..${max}, nodata ${g.noDataCount}`);
  return `${g.width}×${g.height}, ${min.toFixed(2)}–${max.toFixed(2)} m ${g.verticalCrs}, sources ${g.sources.map((s) => s.id).join(',')}`;
});

await step('terrain across a tile seam at 0.5 m vs 1 m', async () => {
  const seam = { minX: 2_600_980, minY: 1_199_490, maxX: 2_601_020, maxY: 1_199_510 };
  const fine = await geo.elevationGrid(seam, { resolution: 0.5 });
  const coarse = await geo.elevationGrid(seam, { resolution: 1 });
  expect(fine.noDataCount === 0 && coarse.noDataCount === 0, 'NaN at the seam');
  expect(fine.sources.length === 2, `expected 2 tiles, got ${fine.sources.length}`);
  let maxDiff = 0;
  for (let r = 0; r < coarse.height; r++)
    for (let c = 0; c < coarse.width; c++)
      maxDiff = Math.max(maxDiff, Math.abs(coarse.values[r * coarse.width + c] - fine.values[2 * r * fine.width + 2 * c]));
  expect(maxDiff < 0.5, `grids disagree by ${maxDiff.toFixed(3)} m at shared nodes across the seam`);
  return `levels ${fine.sources[0].gsd} m / ${coarse.sources[0].gsd} m, max |Δ| at shared nodes ${maxDiff.toFixed(3)} m`;
});

await step('terrain vs the official point height service', async () => {
  const g = await geo.elevationGrid({ minX: 2_600_400, minY: 1_199_500, maxX: 2_600_410, maxY: 1_199_510 }, { resolution: 0.5 });
  const res = await fetch('https://api3.geo.admin.ch/rest/services/height?easting=2600400&northing=1199510&sr=2056', {
    headers: { 'User-Agent': 'ifc-lite-geodata-ch' },
  });
  const ref = Number((await res.json()).height);
  const ours = g.values[0];
  expect(Math.abs(ours - ref) < 0.5, `grid ${ours} vs height service ${ref}`);
  return `grid ${ours.toFixed(2)} m vs height service ${ref.toFixed(2)} m`;
});

await step('swissBUILDINGS3D tiles', async () => {
  const r = await geo.buildingTiles(box);
  expect(r.assets.length > 0, 'no tiles');
  return r.assets.map((a) => `${a.tileId} ${a.format} ${(a.size / 1e6).toFixed(1)} MB ${a.acquired?.slice(0, 4)}`).join('; ');
});

await step('roads in a 1 km box (cell splitting)', async () => {
  const r = await geo.features(VECTOR_LAYERS.roads, { minX: 2_600_000, minY: 1_199_000, maxX: 2_601_000, maxY: 1_200_000 });
  // `truncated` covers both causes: cells still full at the depth limit and a spent request budget.
  expect(r.features.length > 200 && !r.truncated, `${r.features.length} features, truncated ${r.truncated} (${r.truncatedCells.length} capped cells, ${r.unqueriedCells.length} unqueried)`);
  return `${r.features.length} features in ${r.requests} queries, ${r.networkRequests} network requests`;
});

await step('building register points in a polygon', async () => {
  const tri = { type: 'Polygon', coordinates: [[[2_600_300, 1_199_400], [2_600_700, 1_199_400], [2_600_300, 1_199_800], [2_600_300, 1_199_400]]] };
  const r = await geo.features(VECTOR_LAYERS.buildingRegister, tri);
  expect(r.features.length > 0 && !r.truncated, `${r.features.length} GWR entries, truncated ${r.truncated}`);
  return `${r.features.length} GWR entries in ${r.requests} queries`;
});

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed, ${geo.requestCount} network requests`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
