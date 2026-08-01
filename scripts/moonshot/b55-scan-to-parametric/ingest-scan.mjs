#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.5 stage 1 -- ingest and characterize the scan.
 *
 * Reads a multi-GB E57 through `@ifc-lite/pointcloud`'s existing
 * `E57StreamingSource` (bounded window, page-CRC stripped on the fly) rather
 * than a new parser: the repo already ships a reader that does not allocate
 * the file. Node's `openAsBlob` supplies the lazy `Blob` the source expects,
 * so nothing is copied to disk.
 *
 * Emits, into a caller-supplied OUT directory (never the repo -- the source
 * is client data):
 *   sub.f32       every Nth point, xyz float32 little-endian
 *   ingest.json   full-cloud statistics: exact bbox, per-axis 1 cm histograms,
 *                 point count, timing, throughput
 *
 * Statistics are over ALL points, not the subsample: the stride only governs
 * what is retained for the later geometric passes.
 *
 * Usage: node ingest-scan.mjs <file.e57> <outDir> [--stride N] [--chunk N]
 */

import { openAsBlob, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { E57StreamingSource } from '../../../packages/pointcloud/dist/index.js';

const args = process.argv.slice(2);
const src = args[0];
const outDir = args[1];
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const STRIDE = flag('--stride', 10);
const CHUNK = flag('--chunk', 2_000_000);
/** Histogram bin, metres. 1 cm resolves a floor slab from its screed. */
const BIN = 0.01;
/** Histogram window per axis, metres, centred on 0 (E57 declares |x|<=9). */
const HALF = 16;
const NBINS = Math.round((2 * HALF) / BIN);

mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const blob = await openAsBlob(src);
const source = new E57StreamingSource(blob, { downsample: { stride: 1 } });
const info = await source.open();

const hist = [new Float64Array(NBINS), new Float64Array(NBINS), new Float64Array(NBINS)];
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
let total = 0;
let kept = 0;
let nonFinite = 0;
let outOfHistRange = 0;

const out = createWriteStream(join(outDir, 'sub.f32'));
const writeBuf = (buf) => new Promise((res) => { if (!out.write(buf)) out.once('drain', res); else res(); });

for (;;) {
  const chunk = await source.next(CHUNK);
  if (!chunk) break;
  const p = chunk.positions;
  const n = chunk.pointCount;
  const keepIdx = [];
  for (let i = 0; i < n; i++) {
    const gi = total + i;
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nonFinite++; continue; }
    const v = [x, y, z];
    for (let a = 0; a < 3; a++) {
      if (v[a] < min[a]) min[a] = v[a];
      if (v[a] > max[a]) max[a] = v[a];
      const b = Math.floor((v[a] + HALF) / BIN);
      if (b >= 0 && b < NBINS) hist[a][b]++; else outOfHistRange++;
    }
    if (gi % STRIDE === 0) keepIdx.push(i);
  }
  total += n;
  if (keepIdx.length) {
    const buf = Buffer.allocUnsafe(keepIdx.length * 12);
    let o = 0;
    for (const i of keepIdx) {
      buf.writeFloatLE(p[i * 3], o); o += 4;
      buf.writeFloatLE(p[i * 3 + 1], o); o += 4;
      buf.writeFloatLE(p[i * 3 + 2], o); o += 4;
    }
    await writeBuf(buf);
    kept += keepIdx.length;
  }
  if (total % 10_000_000 < CHUNK) {
    process.stderr.write(`  ${(total / 1e6).toFixed(1)}M points, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  }
}
source.close();
await new Promise((r) => out.end(r));

const elapsedMs = Date.now() - t0;
/** Compress a histogram to its non-empty run so ingest.json stays small. */
const pack = (h) => {
  let lo = 0; while (lo < NBINS && h[lo] === 0) lo++;
  let hi = NBINS - 1; while (hi > lo && h[hi] === 0) hi--;
  return { binSize: BIN, origin: -HALF + lo * BIN, counts: Array.from(h.subarray(lo, hi + 1)) };
};
const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
writeFileSync(join(outDir, 'ingest.json'), JSON.stringify({
  sourceBytes: blob.size,
  declaredPointCount: info.pointCount ?? info.totalPoints ?? null,
  decodedPointCount: total,
  keptPointCount: kept,
  stride: STRIDE,
  nonFinite,
  outOfHistRange,
  hasColor: info.hasColor,
  hasIntensity: info.hasIntensity,
  bbox: { min, max, extent },
  /** Points per m3 of the bounding box, and per m2 of its plan footprint. */
  densityPerM3: total / (extent[0] * extent[1] * extent[2]),
  densityPerPlanM2: total / (extent[0] * extent[1]),
  histograms: { x: pack(hist[0]), y: pack(hist[1]), z: pack(hist[2]) },
  elapsedMs,
  megaPointsPerSecond: total / 1e3 / elapsedMs,
}, null, 2));
process.stderr.write(`done: ${total} points in ${(elapsedMs / 1000).toFixed(1)}s, kept ${kept}\n`);
