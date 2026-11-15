/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opt-in live smoke run against swisstopo's buildings tileset. Never run in CI.
 *
 *   pnpm --filter @ifc-lite/tiles3d build
 *   node packages/tiles3d/scripts/live-smoke.mjs [--json out.json]
 *
 * It probes a handful of small sites and two 500 m boxes, keeps every response
 * in a disk store (TILES3D_SMOKE_STORE, default <tmp>/tiles3d-smoke-store) so a
 * re-run makes no requests, and sends a generic User-Agent only.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSwisstopoBuildings, ecefToGeodetic } from '../dist/index.js';

const STORE = process.env.TILES3D_SMOKE_STORE ?? join(tmpdir(), 'tiles3d-smoke-store');
mkdirSync(STORE, { recursive: true });
const RELEASE = process.env.TILES3D_SMOKE_RELEASE; // undefined: follow the moving root
let liveRequests = 0;
let liveTransferBytes = 0;
const requested = [];

/** fetch backed by the disk store; records transfer size (Content-Length) of live responses. */
async function storeFetch(url, init) {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 32);
  requested.push(url);
  const body = join(STORE, key + '.bin');
  const meta = join(STORE, key + '.json');
  if (!existsSync(body)) {
    liveRequests++;
    const res = await fetch(url, { signal: init.signal, headers: { 'User-Agent': 'tiles3d-reader-smoke/0.1' } });
    if (!res.ok) return { ok: false, status: res.status, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const transfer = Number(res.headers.get('content-length') ?? bytes.byteLength);
    liveTransferBytes += transfer;
    writeFileSync(body, bytes);
    writeFileSync(meta, JSON.stringify({ url, transfer, encoding: res.headers.get('content-encoding'), date: new Date().toISOString() }));
  }
  const bytes = readFileSync(body);
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

function transferOf(url) {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 32);
  try {
    return JSON.parse(readFileSync(join(STORE, key + '.json'), 'utf8')).transfer;
  } catch {
    return 0;
  }
}

/** Region of +-halfMetres around a point. */
function box(lon, lat, halfMetres) {
  const dLat = halfMetres / 111_320;
  const dLon = halfMetres / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat };
}

function up(x, y, z) {
  const g = ecefToGeodetic(x, y, z);
  const la = (g.lat * Math.PI) / 180, lo = (g.lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

/** Area fractions of up-facing, vertical (wall-like) and down-facing triangles per material. */
function orientation(features) {
  const byMat = new Map();
  for (const f of features) {
    const p = f.positions;
    for (const g of f.groups) {
      const key = `${g.material ?? '-'}:${g.materialName ?? ''}:${(g.baseColorFactor ?? []).map((v) => v.toFixed(2)).join(',')}`;
      const acc = byMat.get(key) ?? { up: 0, wall: 0, down: 0, tris: 0 };
      for (let t = g.start; t < g.start + g.count; t += 3) {
        const a = f.indices[t] * 3, b = f.indices[t + 1] * 3, c = f.indices[t + 2] * 3;
        const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
        const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(...n);
        if (len === 0) continue;
        const area = len / 2;
        const upv = up(p[a], p[a + 1], p[a + 2]);
        const cos = (n[0] * upv[0] + n[1] * upv[1] + n[2] * upv[2]) / len;
        if (cos > 0.2) acc.up += area;
        else if (cos < -0.2) acc.down += area;
        else acc.wall += area;
        acc.tris++;
      }
      byMat.set(key, acc);
    }
  }
  const out = {};
  for (const [k, a] of byMat) {
    const total = a.up + a.wall + a.down || 1;
    out[k] = { triangles: a.tris, up: +(a.up / total).toFixed(3), wall: +(a.wall / total).toFixed(3), down: +(a.down / total).toFixed(3) };
  }
  return out;
}

function heights(features, tiles) {
  const rows = [];
  for (const f of features) {
    let hMin = Infinity, hMax = -Infinity;
    for (let i = 0; i < f.positions.length; i += 3) {
      const g = ecefToGeodetic(f.positions[i], f.positions[i + 1], f.positions[i + 2]);
      hMin = Math.min(hMin, g.height);
      hMax = Math.max(hMax, g.height);
    }
    const a = f.attributes;
    if (typeof a.GELAENDEPUNKT === 'number' || typeof a.DACH_MAX === 'number') {
      rows.push({ hMin, hMax, terrain: a.GELAENDEPUNKT, roofMax: a.DACH_MAX });
    }
  }
  const diffs = (k1, k2) => rows.filter((r) => typeof r[k2] === 'number').map((r) => r[k1] - r[k2]);
  const stat = (d) => (d.length ? { n: d.length, median: +median(d).toFixed(2), min: +Math.min(...d).toFixed(2), max: +Math.max(...d).toFixed(2) } : null);
  const rtcHeights = tiles.filter((t) => t.rtcCenter).map((t) => +ecefToGeodetic(...t.rtcCenter).height.toFixed(2));
  return { minVertexMinusTerrain: stat(diffs('hMin', 'terrain')), maxVertexMinusDachMax: stat(diffs('hMax', 'roofMax')), rtcCenterEllipsoidalHeights: rtcHeights };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function columns(features, tiles) {
  const present = new Set(tiles.flatMap((t) => t.attributeNames ?? []));
  const egid = features.filter((f) => f.attributes.EGID !== undefined && f.attributes.EGID !== null && f.attributes.EGID !== '').length;
  return { columns: [...present].sort(), features: features.length, egidPopulated: egid };
}

async function site(name, lon, lat, half) {
  const before = { r: liveRequests, b: liveTransferBytes, n: requested.length };
  const res = await readSwisstopoBuildings({ region: box(lon, lat, half), fetch: storeFetch, concurrency: 2, release: RELEASE, maxRequests: 60, maxBytes: 64 * 1024 * 1024 });
  const transfer = requested.slice(before.n).reduce((s, u) => s + transferOf(u), 0);
  return {
    name, lon, lat, halfMetres: half,
    complete: res.complete, truncated: res.truncated,
    tiles: res.tiles.map((t) => t.url.split('/v1/')[1]),
    issues: res.issues.slice(0, 10),
    stats: { ...res.stats, liveRequestsThisRun: liveRequests - before.r, liveTransferBytesThisRun: liveTransferBytes - before.b, transferBytesAllRequests: transfer },
    ...columns(res.features, res.tiles),
    orientation: orientation(res.features),
    heights: heights(res.features, res.tiles),
  };
}

const SITES = [
  ['Bern (BE), old town', 7.4390, 46.9515],
  ['Zürich (ZH), Hauptbahnhof', 8.5402, 47.3779],
  ['Geneva (GE), Plainpalais', 6.1427, 46.1987],
  ['Andermatt (UR), alpine village', 8.5935, 46.6357],
  ['Lugano (TI), centre', 8.9511, 46.0037],
];

const report = { date: new Date().toISOString(), store: STORE, sites: [], boxes500: [] };
for (const [name, lon, lat] of SITES) report.sites.push(await site(name, lon, lat, 40));
report.boxes500.push(await site('urban 500 m box: Zürich HB', 8.5402, 47.3779, 250));
report.boxes500.push(await site('rural 500 m box: Trub (BE), Emmental', 7.8786, 46.9418, 250));
report.liveRequests = liveRequests;
report.liveTransferBytes = liveTransferBytes;
const out = process.argv.indexOf('--json');
if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
