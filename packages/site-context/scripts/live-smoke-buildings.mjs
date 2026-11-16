/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opt-in smoke test of the buildings layer against the LIVE swisstopo 3D
 * Tiles. Not run in CI. Site: the public Bundesplatz in Bern, 300 m radius,
 * with the Federal Palace (Parliament Building) as the subject, found in the
 * federal building register (GWR) through the geodata client.
 *
 *   pnpm --filter @ifc-lite/geo --filter @ifc-lite/geodata-ch --filter @ifc-lite/tiles3d --filter @ifc-lite/site-context build
 *   node packages/site-context/scripts/live-smoke-buildings.mjs [radius]
 *
 * Tile responses are kept on disk (SITE_CONTEXT_SMOKE_STORE, default
 * <tmp>/site-context-smoke-tiles), so a re-run costs no tile requests; the
 * swisstopo index JSON files are 5–12 MB each. A generic User-Agent only.
 * It runs the build twice (cold, then from the store) and reports requests,
 * bytes, timing, the subject match and the register cross-check.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCrs } from '@ifc-lite/geo';
import { createSwissGeodata, VECTOR_LAYERS } from '@ifc-lite/geodata-ch';
import { BUILDING_SET, buildSiteContext, decodeSiteContextGlb, encodeSiteContextGlb, summarizeSiteContext } from '../dist/index.js';

const radius = Number(process.argv[2] ?? 300);
const centre = { x: 2_600_423, y: 1_199_521 }; // Bundesplatz, Bern
const PARLIAMENT = { lon: 7.44412, lat: 46.94660 }; // a point inside the Federal Palace (Parliament Building)
const STORE = process.env.SITE_CONTEXT_SMOKE_STORE ?? join(tmpdir(), 'site-context-smoke-tiles');

const cache = {
  hits: 0,
  path: (url) => join(STORE, `${createHash('sha256').update(url).digest('hex')}.bin`),
  async get(url) {
    try {
      const b = await readFile(cache.path(url));
      cache.hits++;
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    }
  },
  async set(url, bytes) {
    await mkdir(STORE, { recursive: true });
    await writeFile(`${cache.path(url)}.tmp`, bytes);
    await rename(`${cache.path(url)}.tmp`, cache.path(url));
  },
};
const tilesFetch = (url, init) => fetch(url, { signal: init.signal, headers: { ...init.headers, 'User-Agent': 'ifc-lite-site-context-smoke/0.1' } });

const lv95 = await resolveCrs({ epsg: 2056 });
const [px, py] = lv95.fromWgs84([PARLIAMENT.lon, PARLIAMENT.lat]);
const geodata = createSwissGeodata();
const register = await geodata.features(VECTOR_LAYERS.buildingRegister, { minX: px - 40, minY: py - 40, maxX: px + 40, maxY: py + 40 });
const records = register.features
  .map((f) => ({ egid: String(f.properties.egid ?? f.properties.EGID ?? ''), x: Number(f.properties.gkode), y: Number(f.properties.gkodn) }))
  .filter((r) => r.egid && Number.isFinite(r.x) && Number.isFinite(r.y))
  .sort((a, b) => Math.hypot(a.x - px, a.y - py) - Math.hypot(b.x - px, b.y - py));
const gwr = records[0] ?? null;

async function run() {
  const t0 = Date.now();
  const doc = await buildSiteContext({
    centre,
    radius,
    layers: ['buildings'],
    geodata,
    subject: gwr ? { egid: gwr.egid } : undefined,
    buildings: { fetch: tilesFetch, cache, maxRequests: 200, maxBytes: 128 * 1024 * 1024 },
  });
  return { doc, seconds: (Date.now() - t0) / 1000 };
}

const cold = await run();
const warm = await run();
const layer = cold.doc.layers[0];
const summary = summarizeSiteContext(cold.doc).buildings;
const glb = encodeSiteContextGlb(cold.doc);
const back = decodeSiteContextGlb(glb);
const out = join(tmpdir(), `site-context-buildings-${radius}.glb`);
await writeFile(out, glb);

// Cross-check: the register's coordinate for the subject against the subject's footprint.
let crossCheck = null;
const subject = layer.features.find((f) => f.subject);
if (subject && gwr) {
  const p = subject.mesh.positions;
  let zmin = Infinity;
  for (let i = 2; i < p.length; i += 3) zmin = Math.min(zmin, p[i]);
  const base = [];
  for (let i = 0; i < p.length; i += 3) if (p[i + 2] < zmin + 2) base.push([subject.origin[0] + p[i], subject.origin[1] + p[i + 1]]);
  const xs = base.map((q) => q[0]), ys = base.map((q) => q[1]);
  const bbox = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const mid = { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
  crossCheck = {
    registerPoint: { x: gwr.x, y: gwr.y },
    footprintBoxCentre: mid,
    offsetMetres: Math.round(Math.hypot(gwr.x - mid.x, gwr.y - mid.y) * 100) / 100,
    registerPointInsideFootprintBox: gwr.x >= bbox.minX && gwr.x <= bbox.maxX && gwr.y >= bbox.minY && gwr.y <= bbox.maxY,
    footprintBoxSize: [Math.round(bbox.maxX - bbox.minX), Math.round(bbox.maxY - bbox.minY)],
  };
}

const ok = layer.features.length > 0 && JSON.stringify(back.layers[0].features.map((f) => f.id)) === JSON.stringify(layer.features.map((f) => f.id));
if (!ok) process.exitCode = 1;
console.log(JSON.stringify({
  centre,
  radius,
  buildings: summary.count,
  withEgid: summary.withEgid,
  complete: layer.complete,
  subject: summary.subject,
  gwr: gwr ? { egid: gwr.egid, candidates: records.length } : null,
  crossCheck,
  cold: { seconds: cold.seconds, requests: layer.provenance.requests, bytes: layer.provenance.bytes, cacheHits: layer.provenance.cacheHits },
  warm: { seconds: warm.seconds, requests: warm.doc.layers[0].provenance.requests, cacheHits: warm.doc.layers[0].provenance.cacheHits },
  triangles: layer.provenance.triangles,
  partTriangles: summary.partTriangles,
  glbBytes: glb.byteLength,
  output: out,
  releases: layer.provenance.releases,
  conversion: layer.provenance.conversion,
  issues: layer.issues.map((i) => `${i.severity} ${i.code}${i.count !== undefined ? ` (${i.count})` : ''}: ${i.message.slice(0, 200)}`),
  heightCheck: layer.features.slice(0, 3).map((f) => ({ id: f.id, roofMax: f.attributes[BUILDING_SET].RoofMax, check: f.provenance.heightCheck })),
}, null, 2));
