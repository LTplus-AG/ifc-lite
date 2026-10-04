/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Walk-mode collision on real models, offline: mesh an IFC with the same wasm
 * the viewer uses, index it the way the viewer does, then put a crowd of
 * simulated walkers inside and time every frame.
 *
 *   NODE_OPTIONS=--max-old-space-size=24000 pnpm exec tsx --tsconfig apps/viewer/tsconfig.json \
 *     apps/viewer/scripts/walk-collision-bench.ts tests/models/ara3d/AC20-FZK-Haus.ifc [--walkers 100] [--seconds 10] [--json]
 *
 * Each walker spawns standing on a random slab (the realistic way into walk
 * mode is from inside a building), walks with random turns and sprints, and
 * reports where it ended. The frame time includes the per-frame prefetch the
 * viewer runs, so it is the full collision cost a frame pays.
 */

import { readFileSync } from 'node:fs';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { WalkCollisionWorld, type WalkBounds, type WalkGeometrySource } from '../src/components/viewer/walk/walkCollisionWorld.js';
import { WalkSession, NO_INPUT, type Vec3, type WalkInput } from '../src/components/viewer/walk/walkSession.js';
import { prefetchAround } from '../src/components/viewer/walk/walkPrefetch.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) throw new Error('usage: walk-collision-bench.ts <model.ifc> [--walkers N] [--seconds S] [--json]');
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const WALKERS = flag('walkers', 100);
const SECONDS = flag('seconds', 10);
const JSON_OUT = args.includes('--json');
const FPS = 60;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const mb = (bytes: number): number => Math.round(bytes / 1048576);

const log = (...parts: unknown[]): void => { if (!JSON_OUT) console.log(...parts); };

const bytes = readFileSync(file);
let t = performance.now();
const processor = new GeometryProcessor();
let result: Awaited<ReturnType<GeometryProcessor['process']>>;
try {
  await processor.init();
  result = await processor.process(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
} finally {
  processor.dispose();
}
const meshMs = performance.now() - t;
const meshes = result.meshes;
log(`${file}: ${meshes.length} meshes, ${result.totalTriangles} triangles, meshed in ${(meshMs / 1000).toFixed(1)} s`);

// The scene's view of the same meshes: pieces per entity, and a lazily
// computed, cached world AABB per entity (the scene's `cachedWorldAabb`).
const pieces = new Map<number, MeshData[]>();
for (const m of meshes) {
  const list = pieces.get(m.expressId);
  if (list) list.push(m); else pieces.set(m.expressId, [m]);
}
const boundsCache = new Map<number, WalkBounds | null>();
function entityBounds(id: number): WalkBounds | null {
  if (boundsCache.has(id)) return boundsCache.get(id) ?? null;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const m of pieces.get(id) ?? []) {
    const p = m.positions;
    const ox = m.origin?.[0] ?? 0, oy = m.origin?.[1] ?? 0, oz = m.origin?.[2] ?? 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] + ox, y = p[i + 1] + oy, z = p[i + 2] + oz;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  const b = Number.isFinite(minX) ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } : null;
  boundsCache.set(id, b);
  return b;
}
const source: WalkGeometrySource = {
  entityIds: () => pieces.keys(),
  bounds: entityBounds,
  pieces: (id) => pieces.get(id),
};

global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
t = performance.now();
const world = new WalkCollisionWorld(source);
const buildMs = performance.now() - t;
const b = world.bounds!;
log(`world: ${world.stats.entities} entities indexed in ${buildMs.toFixed(1)} ms (incl. first-time entity bounds)`);
log(`bounds: x ${b.min.x.toFixed(1)}..${b.max.x.toFixed(1)}  y ${b.min.y.toFixed(1)}..${b.max.y.toFixed(1)}  z ${b.min.z.toFixed(1)}..${b.max.z.toFixed(1)} (m, Y-up)`);

// Spawn candidates: the tops of slabs big enough to stand on.
const slabs: WalkBounds[] = [];
for (const [id, list] of pieces) {
  const type = list[0]?.ifcType?.toLowerCase();
  if (type !== 'ifcslab' && type !== 'ifcslabstandardcase' && type !== 'ifcslabelementedcase') continue;
  const sb = entityBounds(id);
  if (sb && sb.max.x - sb.min.x > 2 && sb.max.z - sb.min.z > 2) slabs.push(sb);
}
log(`spawn slabs: ${slabs.length}`);

const random = rng(20261004);
const frameTimes: number[] = [];
const spawnOutcomes: Record<string, number> = {};
let spawnMsMax = 0;
let groundPlaneEnds = 0;
let stuck = 0;
let walked = 0;
let peakPrepared = 0;
/** Frames where the capsule's centre column passed DOWN through a floor: a tunnel through geometry. */
let tunnels = 0;

for (let w = 0; w < WALKERS; w++) {
  const session = new WalkSession(world);
  let eye: Vec3;
  let look: Vec3;
  if (slabs.length > 0 && w % 10 !== 9) {
    const s = slabs[Math.floor(random() * slabs.length)];
    eye = { x: s.min.x + random() * (s.max.x - s.min.x), y: s.max.y + 1.6, z: s.min.z + random() * (s.max.z - s.min.z) };
    const a = random() * Math.PI * 2;
    look = { x: Math.cos(a), y: 0, z: Math.sin(a) };
  } else {
    // Every tenth walker enters from an aerial orbit view, aimed at the model.
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const a = random() * Math.PI * 2, r = Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z);
    eye = { x: cx + Math.cos(a) * r, y: b.max.y + r * 0.5, z: cz + Math.sin(a) * r };
    const target = { x: cx + (random() - 0.5) * (b.max.x - b.min.x) * 0.5, y: b.min.y + (b.max.y - b.min.y) * 0.3, z: cz };
    look = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
  }
  t = performance.now();
  const outcome = session.spawn(eye, look);
  spawnMsMax = Math.max(spawnMsMax, performance.now() - t);
  spawnOutcomes[outcome] = (spawnOutcomes[outcome] ?? 0) + 1;

  const c = session.character;
  const startX = c.feetX, startZ = c.feetZ;
  let heading = Math.atan2(look.z, look.x);
  let input: WalkInput = { ...NO_INPUT, forward: 1 };
  let path = 0, lastX = c.feetX, lastZ = c.feetZ;
  for (let f = 0; f < SECONDS * FPS; f++) {
    if (f % 45 === 0) {
      heading += (random() - 0.5) * 2.2;
      input = { ...NO_INPUT, forward: 1, right: random() < 0.2 ? (random() < 0.5 ? -1 : 1) : 0, run: random() < 0.3, jump: random() < 0.05 };
    }
    const dir = { x: Math.cos(heading), y: 0, z: Math.sin(heading) };
    const beforeX = c.feetX, beforeY = c.feetY, beforeZ = c.feetZ;
    const start = performance.now();
    session.frame(1 / FPS, input, dir);
    prefetchAround(world, c, 2);
    frameTimes.push(performance.now() - start);
    const drop = beforeY - c.feetY;
    if (drop > 0.05 && session.physics) {
      // Probe the column at the start position over the fall: a floor-like
      // surface inside it means the capsule went through a floor.
      const hit = world.raycast(beforeX, beforeY - 0.02, beforeZ, 0, -1, 0, drop - 0.04);
      const moved = Math.hypot(c.feetX - beforeX, c.feetZ - beforeZ);
      if (hit && hit.ny > 0.7 && moved < 0.3) tunnels++;
    }
    path += Math.hypot(c.feetX - lastX, c.feetZ - lastZ);
    lastX = c.feetX; lastZ = c.feetZ;
    peakPrepared = Math.max(peakPrepared, world.stats.preparedTriangles);
  }
  walked += path;
  if (Math.hypot(c.feetX - startX, c.feetZ - startZ) < 0.5 && path < 1) stuck++;
  if (c.feetY <= c.groundY + 0.01) groundPlaneEnds++;
}

frameTimes.sort((x, y) => x - y);
const heapAfter = process.memoryUsage().heapUsed;
const report = {
  file,
  meshes: meshes.length,
  triangles: result.totalTriangles,
  entities: world.stats.entities,
  worldBuildMs: Math.round(buildMs),
  walkers: WALKERS,
  seconds: SECONDS,
  frameMs: {
    p50: +percentile(frameTimes, 0.5).toFixed(3),
    p95: +percentile(frameTimes, 0.95).toFixed(3),
    p99: +percentile(frameTimes, 0.99).toFixed(3),
    max: +frameTimes[frameTimes.length - 1].toFixed(2),
  },
  spawnMsMax: +spawnMsMax.toFixed(1),
  spawnOutcomes,
  preparedEntities: world.stats.prepared,
  preparedMs: Math.round(world.stats.preparedMs),
  peakPreparedTriangles: peakPrepared,
  evicted: world.stats.evicted,
  missing: world.stats.missing,
  heapDeltaMB: mb(heapAfter - heapBefore),
  avgPathM: +(walked / WALKERS).toFixed(1),
  stuck,
  tunnels,
  /** Walked out of the building (through a door) and dropped to the model's lowest point. */
  endedOnGroundPlane: groundPlaneEnds,
};
if (JSON_OUT) console.log(JSON.stringify(report));
else console.log(report);
