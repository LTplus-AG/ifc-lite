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
 * Emits, into a caller-supplied OUT directory (never the repo -- the source is
 * client data, and an OUT directory that canonicalises to anywhere inside the
 * worktree is refused before anything is created):
 *   sub.f32       every Nth point, xyz float32 little-endian
 *   ingest.json   full-cloud statistics: exact bbox, per-axis 1 cm histograms,
 *                 point count, timing, throughput
 *
 * Statistics are over ALL points, not the subsample: the stride only governs
 * what is retained for the later geometric passes.
 *
 * Usage: node ingest-scan.mjs <file.e57> <outDir> [--stride N] [--chunk N]
 */

import { openAsBlob, writeFileSync, mkdirSync, createWriteStream, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E57StreamingSource } from '../../../packages/pointcloud/dist/index.js';

const USAGE = 'usage: node ingest-scan.mjs <file.e57> <outDir> [--stride N] [--chunk N]';
const die = (msg) => { console.error(`${msg}\n${USAGE}`); process.exit(2); };

const args = process.argv.slice(2);
const src = args[0];
const outDir = args[1];
// Validated BEFORE anything is created on disk: a mistyped invocation must not
// leave a directory behind, and a non-integer stride would silently turn
// `gi % STRIDE` into a filter that keeps everything or nothing.
if (!src || src.startsWith('--')) die('missing <file.e57>');
if (!outDir || outDir.startsWith('--')) die('missing <outDir>');
if (!existsSync(src)) die(`no such scan file: ${src}`);
const positiveInt = (n, d) => {
  const i = args.indexOf(n);
  if (i < 0) return d;
  const raw = args[i + 1];
  const v = Number(raw);
  if (raw === undefined || raw === '' || !Number.isSafeInteger(v) || v <= 0) {
    die(`${n} needs a positive integer, got ${JSON.stringify(raw)}`);
  }
  return v;
};
const STRIDE = positiveInt('--stride', 10);
const CHUNK = positiveInt('--chunk', 2_000_000);
/** Histogram bin, metres. 1 cm resolves a floor slab from its screed. */
const BIN = 0.01;
/** Histogram window per axis, metres, centred on 0 (E57 declares |x|<=9). */
const HALF = 16;
const NBINS = Math.round((2 * HALF) / BIN);

/**
 * Canonical absolute path, resolving symlinks over the longest EXISTING
 * prefix -- the output directory usually does not exist yet, so `realpathSync`
 * on the whole path would throw and a plain `resolve` would let a symlinked
 * ancestor point back into the repository.
 */
function canonicalPath(p) {
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    if (existsSync(cur)) return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur);
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    tail.unshift(basename(cur));
    cur = parent;
  }
}
const REPO_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../../..'));
const OUT_DIR = canonicalPath(outDir);
const insideRepo = (p) => {
  const rel = relative(REPO_ROOT, p);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};
// The source is client data and so is everything derived from it point-wise.
// Nothing this script writes may land in the worktree, including its root.
if (insideRepo(OUT_DIR)) die(`refusing to write inside the repository: ${OUT_DIR}`);

const SUB_PATH = join(OUT_DIR, 'sub.f32');
const INGEST_PATH = join(OUT_DIR, 'ingest.json');
mkdirSync(OUT_DIR, { recursive: true });

const t0 = Date.now();
const blob = await openAsBlob(src);
const source = new E57StreamingSource(blob, { downsample: { stride: 1 } });
const info = await source.open();

const hist = [new Float64Array(NBINS), new Float64Array(NBINS), new Float64Array(NBINS)];
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
let total = 0;
let kept = 0;
let finitePoints = 0;
let nonFinite = 0;
let outOfHistRange = 0;

const out = createWriteStream(SUB_PATH);
/** First error the output stream reported, latched so it cannot be missed. */
let streamError = null;
out.on('error', (e) => { streamError ??= e; });
/**
 * Backpressure-aware write that REJECTS on a stream error. The earlier version
 * resolved unconditionally and awaited `drain`, so a failed write (ENOSPC, a
 * vanished directory) either passed silently or hung forever waiting for a
 * `drain` that a destroyed stream never emits.
 */
const writeBuf = (buf) => new Promise((res, rej) => {
  if (streamError) { rej(streamError); return; }
  const ok = out.write(buf, (err) => { if (err) rej(err); });
  if (ok) { res(); return; }
  const onDrain = () => { out.off('error', onErr); res(); };
  const onErr = (e) => { out.off('drain', onDrain); rej(e); };
  out.once('drain', onDrain);
  out.once('error', onErr);
});
/** A close failure must never mask the failure that got us here. */
const closeSource = () => { try { source.close(); } catch { /* ignore */ } };

try {
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
      finitePoints++;
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
} catch (err) {
  closeSource();
  out.destroy();
  throw err;
}
closeSource();
await new Promise((res, rej) => out.end((err) => {
  const e = err ?? streamError;
  if (e) rej(e); else res();
}));

if (finitePoints === 0) {
  throw new Error(`no point in ${src} has a finite xyz position (${total} decoded, ${nonFinite} non-finite)`);
}

const elapsedMs = Date.now() - t0;
/** Compress a histogram to its non-empty run so ingest.json stays small. */
const pack = (h) => {
  let lo = 0; while (lo < NBINS && h[lo] === 0) lo++;
  let hi = NBINS - 1; while (hi > lo && h[hi] === 0) hi--;
  return { binSize: BIN, origin: -HALF + lo * BIN, counts: Array.from(h.subarray(lo, hi + 1)) };
};
const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
// The bbox is built from FINITE points only, so the densities must be too --
// dividing the decoded count by a box that never saw those points overstates
// the measurement.
const bboxVolumeM3 = extent[0] * extent[1] * extent[2];
const bboxPlanAreaM2 = extent[0] * extent[1];
writeFileSync(INGEST_PATH, JSON.stringify({
  sourceBytes: blob.size,
  declaredPointCount: info.pointCount ?? info.totalPoints ?? null,
  decodedPointCount: total,
  finitePointCount: finitePoints,
  keptPointCount: kept,
  stride: STRIDE,
  nonFinite,
  outOfHistRange,
  hasColor: info.hasColor,
  hasIntensity: info.hasIntensity,
  bbox: { min, max, extent },
  bboxVolumeM3,
  bboxPlanAreaM2,
  /**
   * Finite points per m3 of the bounding box, and per m2 of its plan
   * footprint. NULL, not zero, when the corresponding measure is zero (a
   * planar or single-scanline cloud): the density is then geometrically
   * undefined, and a 0 there would read as "no points".
   */
  densityPerM3: bboxVolumeM3 > 0 ? finitePoints / bboxVolumeM3 : null,
  densityPerPlanM2: bboxPlanAreaM2 > 0 ? finitePoints / bboxPlanAreaM2 : null,
  densityBasis: 'finite points per bounding-box measure; null where that measure is zero',
  histograms: { x: pack(hist[0]), y: pack(hist[1]), z: pack(hist[2]) },
  elapsedMs,
  megaPointsPerSecond: total / 1e3 / elapsedMs,
}, null, 2));
process.stderr.write(`done: ${total} points in ${(elapsedMs / 1000).toFixed(1)}s, kept ${kept}\n`);
