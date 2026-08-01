#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.5 stage 2 -- planar structure and room extraction from the subsampled
 * cloud. NOTHING IN HERE READS THE REFERENCE MODEL. Every threshold is either
 * a stated resolution choice or is derived from the scan's own statistics by
 * a rule written down before it was run (see `--ceiling-cut` below).
 *
 * WHY A CEILING CARVE AND NOT RANSAC-EVERYTHING. The textbook move is RANSAC
 * plane fitting over the whole cloud. On a furnished apartment that yields a
 * hundred planes (table tops, doors, cupboard sides) which then have to be
 * classified and assembled, and the assembly is where scan-to-BIM research
 * actually lives. The structure this exam needs -- one room's floor area, its
 * height, its bounding wall surface -- is recoverable from a much narrower
 * and much more robust observation:
 *
 *   1. Floor and ceiling are the two overwhelming horizontal accumulations in
 *      the z histogram. Fit those two only.
 *   2. Rooms are the connected components of CEILING VISIBILITY in plan. A
 *      wall's own footprint is never scanned -- a scanner standing inside the
 *      rooms sees both wall faces but nothing between them -- so walls appear
 *      as empty channels in the plan raster. Door openings do not leak,
 *      because a doorway has a lintel above it: looking up from a doorway you
 *      see the lintel soffit, not the ceiling.
 *   3. Wall thickness is then the width of the empty channel between two room
 *      components, measured directly in the raster.
 *
 * THE ONE THRESHOLD THAT MATTERS is the height above the floor at which a
 * cell counts as "under a ceiling". Too low and every room merges through the
 * door lintels; too high and a room with a dropped ceiling disappears. It is
 * NOT hand-set. `chooseCeilingCut` sweeps the cut over the whole plausible
 * band and takes the FINEST STABLE segmentation: among runs of consecutive
 * cut values that agree on the room count AND whose total room area varies by
 * less than PLATEAU_TOL, the one with the most rooms, ties broken by the
 * wider plateau, and the cut is that plateau's midpoint. Ranking by room
 * count rather than by plateau width is load-bearing -- see the comment at
 * the ranking itself. That is a stability/persistence criterion computed from
 * the scan alone; the sweep it is chosen from is written into rooms.json so
 * the choice is auditable rather than asserted.
 *
 * Usage: node extract-rooms.mjs <workDir> [--cell 0.025] [--ceiling-cut N]
 *                                 [--principal-frame]
 * Reads  <workDir>/sub.f32, <workDir>/ingest.json
 * Writes <workDir>/rooms.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const USAGE = 'usage: node extract-rooms.mjs <workDir> [--cell 0.025] [--ceiling-cut N] [--principal-frame]';
const die = (msg) => { console.error(`${msg}\n${USAGE}`); process.exit(2); };

const args = process.argv.slice(2);
const WORK = args[0];
if (!WORK || WORK.startsWith('--')) die('missing <workDir>');
/**
 * Every threshold below is a measurement input, so a typo must stop the run
 * rather than propagate: `Number(undefined)` and `Number('0.o25')` are both
 * NaN, and NaN silently poisons the raster (`Math.ceil(NaN)`, every comparison
 * false) all the way to a rooms.json full of nulls.
 */
const num = (n, d) => {
  const i = args.indexOf(n);
  if (i < 0) return d;
  const v = Number(args[i + 1]);
  if (args[i + 1] === undefined || args[i + 1] === '' || !Number.isFinite(v)) {
    die(`${n} needs a finite number, got ${JSON.stringify(args[i + 1])}`);
  }
  return v;
};

/** Plan raster cell, metres. 25 mm keeps a 90 mm partition 3.6 cells wide. */
const CELL = num('--cell', 0.025);
/** Half-width of the band used to refine a horizontal plane, metres. */
const PLANE_BAND = num('--plane-band', 0.03);
/** A plan cell must hold at least this many subsampled points to count. */
const MIN_CELL_POINTS = num('--min-cell-points', 2);
/** Components smaller than this are scan speckle, not rooms. m^2. */
const MIN_ROOM_AREA = num('--min-room-area', 1.0);
/** Douglas-Peucker tolerance for the emitted room outline, metres. */
const DP_EPS = num('--dp-eps', 0.05);
/** Enclosed voids up to this area are sensor dropout and get filled; larger
 *  ones are treated as real (an un-entered room, a duct) and left out. m^2. */
const MAX_FILL_HOLE = num('--max-fill-hole', 0.25);
/** Ceiling-cut sweep: range, step, and the plateau's area-agreement band. */
const SWEEP_LO = num('--sweep-lo', 1.40);
const SWEEP_STEP = 0.05;
const PLATEAU_TOL = num('--plateau-tol', 0.02);
// Ranges, not just finiteness: a zero or negative cell size divides the plan
// raster by zero, and a min-cell count below 1 makes every empty cell occupied.
if (!(CELL > 0)) die('--cell must be greater than 0');
if (!(PLANE_BAND > 0)) die('--plane-band must be greater than 0');
if (!(MIN_CELL_POINTS >= 1)) die('--min-cell-points must be at least 1');
if (!(MIN_ROOM_AREA > 0)) die('--min-room-area must be greater than 0');
if (!(DP_EPS >= 0)) die('--dp-eps must not be negative');
if (!(MAX_FILL_HOLE >= 0)) die('--max-fill-hole must not be negative');
if (!(PLATEAU_TOL >= 0)) die('--plateau-tol must not be negative');
if (!(SWEEP_LO > 0)) die('--sweep-lo must be greater than 0');

/**
 * `--principal-frame` rasterizes in the BUILDING's frame instead of the
 * world's. This apartment sits at roughly 45 degrees to the E57 axes, and an
 * axis-aligned raster turns every wall into a staircase: the cell-count area
 * is unaffected (a staircase has the same area as the line it approximates)
 * but the PERIMETER is inflated by up to sqrt(2), and everything derived from
 * perimeter -- the bounding wall surface, the wall runs -- inherits that.
 * The angle is the orientation of the minimum-area rectangle of the scanned
 * footprint, i.e. it comes from the scan and nothing else.
 */
const PRINCIPAL = args.includes('--principal-frame');

const ingest = JSON.parse(readFileSync(join(WORK, 'ingest.json'), 'utf8'));
const rawBytes = readFileSync(join(WORK, 'sub.f32'));
// sub.f32 is a flat run of xyz float32 triples, 12 B each. A length that is
// not a multiple of 12 means a truncated ingest (a killed run, a full disk),
// and a trailing partial record would be read as a point at whatever the
// pooled buffer happened to hold.
if (rawBytes.byteLength === 0 || rawBytes.byteLength % 12 !== 0) {
  throw new Error(`${join(WORK, 'sub.f32')} is ${rawBytes.byteLength} B, not a whole number of 12 B xyz records -- re-run ingest-scan.mjs`);
}
const rawPts = new Float32Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength / 4);
const N = rawBytes.byteLength / 12;

/** Andrew's monotone chain over a decimated point set. */
function convexHull(ps) {
  const s = ps.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of s) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
/** Orientation of the minimum-area bounding rectangle, radians in [0, pi/2). */
function principalAngle(ps) {
  const hull = convexHull(ps);
  let best = { area: Infinity, theta: 0 };
  for (const [i, a] of hull.entries()) {
    const b = hull[(i + 1) % hull.length];
    const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-th), s = Math.sin(-th);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of hull) {
      const x = px * c - py * s, y = px * s + py * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < best.area) best = { area, theta: th };
  }
  let t = best.theta % (Math.PI / 2);
  if (t < 0) t += Math.PI / 2;
  return t;
}

let THETA = 0;
let pts = rawPts;
if (PRINCIPAL) {
  // Hull of every 97th subsampled point (a prime stride, so the decimation
  // does not alias with the E57 record order) -- plenty for a hull.
  const sample = [];
  for (let i = 0; i < N; i += 97) sample.push([rawPts[i * 3], rawPts[i * 3 + 1]]);
  THETA = principalAngle(sample);
  const c = Math.cos(-THETA), s = Math.sin(-THETA);
  pts = new Float32Array(rawPts.length);
  for (let i = 0; i < N; i++) {
    const x = rawPts[i * 3], y = rawPts[i * 3 + 1];
    pts[i * 3] = x * c - y * s;
    pts[i * 3 + 1] = x * s + y * c;
    pts[i * 3 + 2] = rawPts[i * 3 + 2];
  }
}
/** Rotate a plan point from the raster frame back to the world frame. */
const unrotate = ([x, y]) => {
  if (!PRINCIPAL) return [x, y];
  const c = Math.cos(THETA), s = Math.sin(THETA);
  return [x * c - y * s, x * s + y * c];
};

// ---------------------------------------------------------------- planes ---
/** Argmax bin of the full-cloud z histogram inside [lo, hi), then a
 *  count-weighted mean over +-PLANE_BAND around it. */
function fitHorizontalPlane(h, lo, hi) {
  let best = -1, bestCount = -1;
  for (let i = 0; i < h.counts.length; i++) {
    const z = h.origin + i * h.binSize;
    if (z < lo || z >= hi) continue;
    if (h.counts[i] > bestCount) { bestCount = h.counts[i]; best = i; }
  }
  // No bin in the window, or a window with no point mass at all, is missing
  // data -- not a plane at z = NaN. Returning NaN here would flow into the
  // ceiling cut, the room heights and every quantity downstream as a number.
  if (best < 0) throw new Error(`no z-histogram bin inside [${lo}, ${hi}) -- the scan has no horizontal accumulation there`);
  const zPeak = h.origin + best * h.binSize;
  let wsum = 0, w = 0;
  for (let i = 0; i < h.counts.length; i++) {
    const z = h.origin + i * h.binSize;
    if (Math.abs(z - zPeak) > PLANE_BAND) continue;
    wsum += z * h.counts[i]; w += h.counts[i];
  }
  if (!(w > 0)) throw new Error(`z-histogram band +-${PLANE_BAND} m around ${zPeak} holds no points -- cannot fit a horizontal plane`);
  return { z: wsum / w, peakZ: zPeak, peakBinPoints: bestCount, bandPoints: w };
}

const hz = ingest.histograms.z;
const zMid = (ingest.bbox.min[2] + ingest.bbox.max[2]) / 2;
const floorPlane = fitHorizontalPlane(hz, ingest.bbox.min[2], zMid);
const ceilPlane = fitHorizontalPlane(hz, zMid, ingest.bbox.max[2] + 1);

// ------------------------------------------------------------ plan raster ---
// Raster extent from the (possibly rotated) points, not from ingest.bbox:
// under --principal-frame the world bbox no longer bounds the plan.
let pminX = Infinity, pminY = Infinity, pmaxX = -Infinity, pmaxY = -Infinity;
for (let i = 0; i < N; i++) {
  const x = pts[i * 3], y = pts[i * 3 + 1];
  if (x < pminX) pminX = x; if (x > pmaxX) pmaxX = x;
  if (y < pminY) pminY = y; if (y > pmaxY) pmaxY = y;
}
const ox = pminX, oy = pminY;
const nx = Math.ceil((pmaxX - ox) / CELL) + 1;
const ny = Math.ceil((pmaxY - oy) / CELL) + 1;
const maxZ = new Float32Array(nx * ny).fill(-Infinity);
const count = new Int32Array(nx * ny);
for (let i = 0; i < N; i++) {
  const k = (((pts[i * 3 + 1] - oy) / CELL) | 0) * nx + (((pts[i * 3] - ox) / CELL) | 0);
  count[k]++;
  if (pts[i * 3 + 2] > maxZ[k]) maxZ[k] = pts[i * 3 + 2];
}

function maskFor(cut) {
  const m = new Uint8Array(nx * ny);
  for (let k = 0; k < m.length; k++) {
    if (count[k] >= MIN_CELL_POINTS && maxZ[k] - floorPlane.z >= cut) m[k] = 1;
  }
  return m;
}

/** 4-connected labelling; returns cell-index arrays per component. */
function components(m) {
  const lab = new Int32Array(nx * ny).fill(-1);
  const out = [];
  const st = new Int32Array(nx * ny);
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    const id = out.length;
    let sp = 0; st[sp++] = s; lab[s] = id;
    const cells = [];
    while (sp > 0) {
      const k = st[--sp];
      cells.push(k);
      const x = k % nx, y = (k / nx) | 0;
      const P = (j) => { if (m[j] && lab[j] < 0) { lab[j] = id; st[sp++] = j; } };
      if (x > 0) P(k - 1);
      if (x < nx - 1) P(k + 1);
      if (y > 0) P(k - nx);
      if (y < ny - 1) P(k + nx);
    }
    out.push(cells);
  }
  return { lab, comps: out };
}

const cellArea = CELL * CELL;

function chooseCeilingCut() {
  const sweep = [];
  for (let c = ceilPlane.z - floorPlane.z; c >= SWEEP_LO - 1e-9; c -= SWEEP_STEP) {
    const rooms = components(maskFor(c)).comps
      .map((cs) => cs.length * cellArea)
      .filter((a) => a >= MIN_ROOM_AREA)
      .sort((a, b) => b - a);
    sweep.push({ cut: +c.toFixed(3), roomCount: rooms.length, totalArea: rooms.reduce((a, b) => a + b, 0), areas: rooms.map((a) => +a.toFixed(3)) });
  }
  let best = null;
  /** Widest stable plateau per room count, emitted so the ranking rule below
   *  can be checked against the data instead of taken on the prose's word. */
  const widestPerRoomCount = new Map();
  for (let i = 0; i < sweep.length; i++) {
    for (let j = i; j < sweep.length; j++) {
      if (sweep[j].roomCount !== sweep[i].roomCount) break;
      const slice = sweep.slice(i, j + 1);
      const mean = slice.reduce((a, s) => a + s.totalArea, 0) / slice.length;
      const spread = Math.max(...slice.map((s) => s.totalArea)) - Math.min(...slice.map((s) => s.totalArea));
      if (mean > 0 && spread / mean > PLATEAU_TOL) break;
      // FINEST stable segmentation, not longest. A cut low enough to merge
      // everything through the door lintels is trivially stable over a wide
      // band -- on this scan the one-room plateau is 9 samples wide against
      // the three-room plateau's 5 -- so "longest plateau" reliably picks the
      // degenerate answer. Merging is a strict loss of structure, so rank by
      // room count first and use plateau width only to break ties.
      const cand = { length: slice.length, lo: slice[slice.length - 1].cut, hi: slice[0].cut, roomCount: sweep[i].roomCount };
      const widest = widestPerRoomCount.get(cand.roomCount);
      if (!widest || cand.length > widest.length) widestPerRoomCount.set(cand.roomCount, cand);
      const better = !best
        || cand.roomCount > best.roomCount
        || (cand.roomCount === best.roomCount && cand.length > best.length);
      if (slice.length >= 3 && better) best = cand;
    }
  }
  if (!best) throw new Error('no stable ceiling-cut plateau found');
  const plateausByRoomCount = [...widestPerRoomCount.values()].sort((a, b) => b.roomCount - a.roomCount);
  return { cut: +((best.lo + best.hi) / 2).toFixed(4), plateau: best, plateausByRoomCount, sweep };
}

const cutChoice = chooseCeilingCut();
const CEILING_CUT = num('--ceiling-cut', cutChoice.cut);
const mask = maskFor(CEILING_CUT);
const { comps } = components(mask);

// --------------------------------------------------------------- topology ---
/** Fill enclosed voids up to MAX_FILL_HOLE by flood-filling the complement
 *  from outside a 1-cell margin: what the outside fill cannot reach is
 *  interior. Returns the filled cell set plus a per-hole size list. */
function fillHoles(cells) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of cells) {
    const x = k % nx, y = (k / nx) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  x0--; y0--; x1++; y1++;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const local = new Uint8Array(w * h);
  for (const k of cells) local[((k / nx | 0) - y0) * w + (k % nx) - x0] = 1;
  const seen = new Uint8Array(w * h);
  const stack = [0]; seen[0] = 1;
  while (stack.length) {
    const k = stack.pop();
    const x = k % w, y = (k / w) | 0;
    const P = (j) => { if (!local[j] && !seen[j]) { seen[j] = 1; stack.push(j); } };
    if (x > 0) P(k - 1); if (x < w - 1) P(k + 1);
    if (y > 0) P(k - w); if (y < h - 1) P(k + w);
  }
  // Enclosed voids, grouped so each can be size-tested on its own.
  const holeLab = new Int32Array(w * h).fill(-1);
  const holes = [];
  for (let s = 0; s < local.length; s++) {
    if (local[s] || seen[s] || holeLab[s] >= 0) continue;
    const id = holes.length;
    const st = [s]; holeLab[s] = id;
    const cs = [];
    while (st.length) {
      const k = st.pop(); cs.push(k);
      const x = k % w, y = (k / w) | 0;
      const P = (j) => { if (!local[j] && !seen[j] && holeLab[j] < 0) { holeLab[j] = id; st.push(j); } };
      if (x > 0) P(k - 1); if (x < w - 1) P(k + 1);
      if (y > 0) P(k - w); if (y < h - 1) P(k + w);
    }
    holes.push(cs);
  }
  const filledLocal = local.slice();
  let filledHoles = 0, filledHoleCells = 0, keptHoles = 0;
  for (const cs of holes) {
    if (cs.length * cellArea > MAX_FILL_HOLE) { keptHoles++; continue; }
    filledHoles++; filledHoleCells += cs.length;
    for (const k of cs) filledLocal[k] = 1;
  }
  const filled = [];
  for (let j = 0; j < filledLocal.length; j++) {
    if (filledLocal[j]) filled.push((y0 + ((j / w) | 0)) * nx + x0 + (j % w));
  }
  return {
    filled, filledHoles, filledHoleCells, keptHoles,
    largestHoleM2: holes.length ? Math.max(...holes.map((c) => c.length)) * cellArea : 0,
  };
}

/**
 * Outer boundary of a cell set as a lattice polygon, by chaining the boundary
 * EDGES of the union (each cell side with no filled neighbour) into loops.
 * Directions are chosen so the interior is on the left, i.e. loops come out
 * counter-clockwise, and the polygon's area equals the cell-count area
 * exactly -- no marching-squares half-cell bias.
 */
function traceOutline(cellSet) {
  // The column bound is load-bearing: without it `has(-1, y)` reads
  // `y * nx - 1`, the LAST cell of the row below, and `has(nx, y)` reads the
  // first cell of the row above -- so a room touching either edge of the
  // raster loses boundary edges to a neighbour that is not adjacent to it.
  const has = (x, y) => x >= 0 && x < nx && y >= 0 && y < ny && cellSet.has(y * nx + x);
  const edges = new Map(); // "x,y" -> [[x,y], ...] successors
  const push = (a, b) => {
    const key = `${a[0]},${a[1]}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push(b);
  };
  for (const k of cellSet) {
    const x = k % nx, y = (k / nx) | 0;
    if (!has(x, y - 1)) push([x, y], [x + 1, y]);
    if (!has(x + 1, y)) push([x + 1, y], [x + 1, y + 1]);
    if (!has(x, y + 1)) push([x + 1, y + 1], [x, y + 1]);
    if (!has(x - 1, y)) push([x, y + 1], [x, y]);
  }
  const loops = [];
  for (const [startKey, succ] of edges) {
    while (succ.length) {
      const loop = [];
      let cur = startKey.split(',').map(Number);
      for (let guard = 0; guard < 4 * cellSet.size + 16; guard++) {
        const key = `${cur[0]},${cur[1]}`;
        const list = edges.get(key);
        if (!list || !list.length) break;
        const nxt = list.shift();
        loop.push(cur);
        cur = nxt;
        if (cur[0] === Number(startKey.split(',')[0]) && cur[1] === Number(startKey.split(',')[1])) break;
      }
      if (loop.length >= 4) loops.push(loop);
      else break;
    }
  }
  if (!loops.length) return [];
  // The outer boundary is the loop of greatest absolute area.
  const areaOf = (l) => {
    let a = 0;
    for (let i = 0; i < l.length; i++) {
      const q = l[(i + 1) % l.length];
      a += l[i][0] * q[1] - q[0] * l[i][1];
    }
    return a / 2;
  };
  loops.sort((a, b) => Math.abs(areaOf(b)) - Math.abs(areaOf(a)));
  const outer = loops[0];
  const pruned = [];
  for (let i = 0; i < outer.length; i++) {
    const a = outer[(i - 1 + outer.length) % outer.length], b = outer[i], c = outer[(i + 1) % outer.length];
    if ((b[0] - a[0]) * (c[1] - b[1]) === (b[1] - a[1]) * (c[0] - b[0])) continue;
    pruned.push(b);
  }
  const src = pruned.length >= 3 ? pruned : outer;
  const poly = src.map(([x, y]) => unrotate([ox + x * CELL, oy + y * CELL]));
  return areaOf(src) < 0 ? poly.reverse() : poly;
}

function polygonArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return Math.abs(a) / 2;
}
function polygonPerimeter(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    s += Math.hypot(q[0] - p[i][0], q[1] - p[i][1]);
  }
  return s;
}
/** Closed-polyline Douglas-Peucker. */
function simplify(poly, eps) {
  const dp = (ps) => {
    if (ps.length < 3) return ps;
    let maxD = 0, idx = 0;
    const [axx, ayy] = ps[0], [bxx, byy] = ps[ps.length - 1];
    const len = Math.hypot(bxx - axx, byy - ayy);
    for (let i = 1; i < ps.length - 1; i++) {
      const [px, py] = ps[i];
      const d = len === 0 ? Math.hypot(px - axx, py - ayy)
        : Math.abs((bxx - axx) * (ayy - py) - (axx - px) * (byy - ayy)) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD <= eps) return [ps[0], ps[ps.length - 1]];
    return [...dp(ps.slice(0, idx + 1)).slice(0, -1), ...dp(ps.slice(idx))];
  };
  // Anchor the split at the two most distant vertices so the recursion cannot
  // simplify the whole loop away to a degenerate pair.
  let ia = 0, ib = 0, bestD = -1;
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      const d = Math.hypot(poly[j][0] - poly[i][0], poly[j][1] - poly[i][1]);
      if (d > bestD) { bestD = d; ia = i; ib = j; }
    }
  }
  const first = poly.slice(ia, ib + 1);
  const second = [...poly.slice(ib), ...poly.slice(0, ia + 1)];
  const out = [...dp(first).slice(0, -1), ...dp(second).slice(0, -1)];
  return out;
}

// ----------------------------------------------------------------- rooms ---
const rooms = [];
comps.forEach((cells, compIndex) => {
  if (cells.length * cellArea < MIN_ROOM_AREA) return;
  const fh = fillHoles(cells);
  const set = new Set(fh.filled);
  const outline = traceOutline(set);
  const simple = simplify(outline, DP_EPS);
  // Ceiling level of THIS room: mode of the per-cell max height over its
  // MEASURED cells (filled holes carry no measurement).
  const bins = new Map();
  for (const k of cells) {
    const b = Math.round(maxZ[k] / 0.01);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  let modeBin = 0, modeCount = -1;
  for (const [b, c] of bins) if (c > modeCount) { modeCount = c; modeBin = b; }
  const zCeil = modeBin * 0.01;
  let cx = 0, cy = 0;
  for (const k of fh.filled) { cx += (k % nx); cy += ((k / nx) | 0); }
  rooms.push({
    compIndex,
    rasterAreaM2: fh.filled.length * cellArea,
    measuredCells: cells.length,
    filledCells: fh.filled.length,
    filledHoles: fh.filledHoles,
    filledHoleAreaM2: fh.filledHoleCells * cellArea,
    unfilledHoles: fh.keptHoles,
    largestHoleM2: fh.largestHoleM2,
    outlineVertices: outline.length,
    outlineAreaM2: polygonArea(outline),
    polygon: simple.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]),
    polygonAreaM2: polygonArea(simple),
    polygonPerimeterM: polygonPerimeter(simple),
    zCeiling: zCeil,
    heightM: zCeil - floorPlane.z,
    centroid: unrotate([ox + (cx / fh.filled.length) * CELL, oy + (cy / fh.filled.length) * CELL]),
  });
});
rooms.sort((a, b) => b.rasterAreaM2 - a.rasterAreaM2);
rooms.forEach((r, i) => { r.id = `scan_room_${String(i + 1).padStart(3, '0')}`; });

// -------------------------------------------------- wall-channel thickness ---
/**
 * Between two room components the unscanned wall footprint is a run of mask-0
 * cells. Sweep every raster row and column; each maximal 0-run bounded by two
 * DIFFERENT rooms is one wall crossing. Perpendicular thickness is the
 * SHORTEST family of crossings (oblique scan lines through the same wall are
 * longer, never shorter), so the 10th percentile is the noise-tolerant
 * estimate.
 */
function wallChannels() {
  const { lab } = components(mask);
  const roomOfComp = new Map(rooms.map((r) => [r.compIndex, r.id]));
  const pairRuns = new Map();
  const sweep = (idx, inner, outer) => {
    for (let o = 0; o < outer; o++) {
      let run = 0, prev = -1;
      for (let i = 0; i < inner; i++) {
        const l = lab[idx(o, i)];
        if (l < 0 || !roomOfComp.has(l)) { run++; continue; }
        if (run > 0 && prev >= 0 && prev !== l) {
          const key = prev < l ? `${prev}|${l}` : `${l}|${prev}`;
          if (!pairRuns.has(key)) pairRuns.set(key, []);
          pairRuns.get(key).push(run * CELL);
        }
        prev = l; run = 0;
      }
    }
  };
  sweep((y, x) => y * nx + x, nx, ny);
  sweep((x, y) => y * nx + x, ny, nx);
  const out = [];
  for (const [key, runs] of pairRuns) {
    if (runs.length < 8) continue;
    runs.sort((a, b) => a - b);
    const [a, b] = key.split('|').map(Number);
    out.push({
      between: [roomOfComp.get(a), roomOfComp.get(b)],
      crossings: runs.length,
      thicknessM: runs[Math.floor(runs.length * 0.10)],
      medianCrossingM: runs[Math.floor(runs.length / 2)],
    });
  }
  return out.sort((a, b) => b.crossings - a.crossings);
}
const channels = wallChannels();

const result = {
  params: { CELL, PLANE_BAND, MIN_CELL_POINTS, MIN_ROOM_AREA, DP_EPS, MAX_FILL_HOLE, PLATEAU_TOL, SWEEP_LO, SWEEP_STEP },
  principalFrame: { enabled: PRINCIPAL, thetaRad: THETA, thetaDeg: (THETA * 180) / Math.PI },
  planes: {
    floor: floorPlane,
    ceiling: ceilPlane,
    clearHeightM: ceilPlane.z - floorPlane.z,
  },
  ceilingCut: { used: CEILING_CUT, sweepLoM: SWEEP_LO, sweepStepM: SWEEP_STEP, ...cutChoice },
  raster: { nx, ny, ox, oy, cell: CELL, occupiedCells: count.reduce((a, v) => a + (v >= MIN_CELL_POINTS ? 1 : 0), 0), maskCells: mask.reduce((a, v) => a + v, 0) },
  rooms,
  wallChannels: channels,
  totals: {
    roomCount: rooms.length,
    totalRasterAreaM2: rooms.reduce((a, r) => a + r.rasterAreaM2, 0),
    totalPolygonAreaM2: rooms.reduce((a, r) => a + r.polygonAreaM2, 0),
  },
};
writeFileSync(join(WORK, 'rooms.json'), JSON.stringify(result, null, 2));

console.log(JSON.stringify({
  principalFrame: PRINCIPAL, thetaDeg: +((THETA * 180) / Math.PI).toFixed(3),
  floorZ: +floorPlane.z.toFixed(4), ceilingZ: +ceilPlane.z.toFixed(4),
  clearHeight: +(ceilPlane.z - floorPlane.z).toFixed(4),
  ceilingCut: CEILING_CUT, plateau: cutChoice.plateau,
  rooms: rooms.map((r) => ({
    id: r.id, raster: +r.rasterAreaM2.toFixed(3), outline: +r.outlineAreaM2.toFixed(3),
    poly: +r.polygonAreaM2.toFixed(3), verts: r.polygon.length, h: +r.heightM.toFixed(3),
    holes: r.filledHoles, unfilled: r.unfilledHoles, c: r.centroid.map((v) => +v.toFixed(2)),
  })),
  channels,
}, null, 2));
