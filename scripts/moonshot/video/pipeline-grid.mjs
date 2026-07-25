#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pipeline 2 - the building grid: "we built a million buildings".
 *
 * Generates N distinct world-gym buildings (seeded, mixed families), meshes
 * each once with the wasm GeometryProcessor, lays them out on a square
 * grid, and renders a 240-frame receding shot: start framed on one hero
 * building, pull back and up until the whole grid is visible, buildings
 * materializing in seeded waves radiating out from the hero. Clean plates;
 * frames-metadata.json carries the per-frame visible count for post.
 *
 * Usage:
 *   node scripts/moonshot/video/pipeline-grid.mjs \
 *     [--out DIR] [--count 576] [--frames 240] [--fps 30] [--headed] [--no-video]
 */

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateModel } from '../../../tools/world-gym/generator.mjs';
import { Rng } from '../../../tools/world-gym/lib/rng.mjs';
import { serializeScene } from './lib/scene-bin.mjs';
import { startRenderHost, orbitPosition, framingDistance, smootherstep, easeOutCubic } from './lib/render-host.mjs';
import { hasFfmpeg, assembleMp4, exportSampleJpgs, defaultOutRoot } from './lib/assemble.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const { GeometryProcessor } = await import(
  path.join(REPO_ROOT, 'packages/geometry/dist/index.js')
);

// ---- args ------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const OUT = path.resolve(args.out ?? path.join(defaultOutRoot(), 'grid'));
const COUNT = parseInt(args.count ?? '576', 10);
const FRAMES = parseInt(args.frames ?? '240', 10);
const FPS = parseInt(args.fps ?? '30', 10);
const HEADLESS = !args.headed;
const MAKE_VIDEO = !args['no-video'];

const SIDE = Math.ceil(Math.sqrt(COUNT));
const SCENE_DIR = path.join(OUT, 'scenes');
const FRAME_DIR = path.join(OUT, 'frames');
mkdirSync(SCENE_DIR, { recursive: true });
mkdirSync(FRAME_DIR, { recursive: true });

// Studio palette keyed on ifcType (world-gym models carry no surface styles).
const TYPE_COLORS = {
  IfcWall: [0.84, 0.81, 0.76, 1],
  IfcSlab: [0.6, 0.59, 0.57, 1],
  IfcColumn: [0.52, 0.53, 0.56, 1],
  IfcBeam: [0.55, 0.52, 0.49, 1],
};
const DEFAULT_COLOR = [0.7, 0.68, 0.65, 1];

// ---- 1. generate + mesh every building -------------------------------------
console.log(`[grid] generating + meshing ${COUNT} buildings (${SIDE}x${SIDE} grid)...`);
const processor = new GeometryProcessor();
await processor.init();

const realLog = console.log.bind(console);
console.log = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('[IFC-LITE]')) return;
  realLog(...a);
};

const tMesh = performance.now();
const buildings = [];
for (let seed = 0; seed < COUNT; seed++) {
  const model = generateModel(seed, 'auto');
  const res = await processor.process(new TextEncoder().encode(model.content));
  let meshes = res.meshes;

  // world-gym's frame family authors its roof slab with a storey-local
  // Position that already contains the absolute roof elevation, so the
  // kernel (correctly applying the storey placement on top) puts the roof
  // (storeys-1)*storeyHeight too high. tools/world-gym is read-only for
  // this pipeline, so correct the roof back down here, purely for the
  // video: any mesh floating above the structural top belongs to that roof.
  if (model.family === 'frame') {
    const { storeys, storeyHeight } = model.params;
    const topY = storeys * storeyHeight;
    const delta = (storeys - 1) * storeyHeight;
    if (delta > 0) {
      meshes = meshes.map((m) => {
        let minY = Infinity;
        for (let i = 1; i < m.positions.length; i += 3) {
          const y = m.positions[i] + (m.origin?.[1] ?? 0);
          if (y < minY) minY = y;
        }
        if (minY > topY + 0.5) {
          const o = m.origin ?? [0, 0, 0];
          return { ...m, origin: [o[0], o[1] - delta, o[2]] };
        }
        return m;
      });
    }
  }

  // First pass to learn raw bounds, second pass re-based so the building's
  // local origin is its footprint centre at ground level (scale pops in the
  // viewer then pivot around the building base).
  const probe = serializeScene(meshes, (m) => TYPE_COLORS[m.ifcType] ?? DEFAULT_COLOR);
  const pb = probe.header.bounds;
  const offset = [
    -(pb.min[0] + pb.max[0]) / 2,
    -pb.min[1],
    -(pb.min[2] + pb.max[2]) / 2,
  ];
  const { buffer, header } = serializeScene(
    meshes,
    (m) => TYPE_COLORS[m.ifcType] ?? DEFAULT_COLOR,
    { offset },
  );
  const file = `b_${String(seed).padStart(4, '0')}.bin`;
  writeFileSync(path.join(SCENE_DIR, file), buffer);
  buildings.push({
    seed,
    family: model.family,
    storeys: model.params.storeys ?? 1,
    file,
    bounds: header.bounds,
    footprint: [
      header.bounds.max[0] - header.bounds.min[0],
      header.bounds.max[2] - header.bounds.min[2],
    ],
    height: header.bounds.max[1],
  });
  if (seed % 50 === 0) realLog(`[grid] meshed ${seed}/${COUNT}`);
}
console.log = realLog;
const meshMs = performance.now() - tMesh;
console.log(`[grid] meshed ${COUNT} buildings in ${(meshMs / 1000).toFixed(1)}s`);

// ---- 2. grid layout, hero, waves -------------------------------------------
const feet = buildings
  .map((bl) => Math.max(bl.footprint[0], bl.footprint[1]))
  .sort((a, b) => a - b);
const maxFoot = feet[feet.length - 1];
const p80 = feet[Math.floor(feet.length * 0.8)];
// Cell sized to the 80th-percentile footprint, not the maximum: a max-sized
// cell reads sparse (most buildings are far smaller). The few oversized
// buildings overhang their cell by centimetres into the 5 m gap.
const CELL = Math.ceil(Math.max(p80 + 5, maxFoot * 0.85));
console.log(`[grid] cell size ${CELL} m (p80 footprint ${p80.toFixed(1)} m, max ${maxFoot.toFixed(1)} m)`);

// Deterministic placement: shuffle buildings across cells so families mix
// visually, but keep the hero (a 3+ storey frame building) at the centre.
const heroIdx = buildings.findIndex((bl) => bl.family === 'frame' && bl.storeys >= 3);
const hero = buildings[heroIdx >= 0 ? heroIdx : 0];
const others = buildings.filter((bl) => bl !== hero);
const shuffleRng = new Rng('grid-layout:v1');
for (let i = others.length - 1; i > 0; i--) {
  const j = Math.floor(shuffleRng.float() * (i + 1));
  [others[i], others[j]] = [others[j], others[i]];
}

const centerCell = Math.floor(SIDE / 2);
const cells = [];
for (let r = 0; r < SIDE; r++) {
  for (let c = 0; c < SIDE; c++) cells.push([c, r]);
}
const heroCell = [centerCell, centerCell];
const otherCells = cells.filter(([c, r]) => !(c === heroCell[0] && r === heroCell[1]));
const placed = [];
const cellPos = ([c, r]) => [(c - (SIDE - 1) / 2) * CELL, (r - (SIDE - 1) / 2) * CELL];
placed.push({ ...hero, cell: heroCell, pos: cellPos(heroCell) });
for (let i = 0; i < others.length && i < otherCells.length; i++) {
  placed.push({ ...others[i], cell: otherCells[i], pos: cellPos(otherCells[i]) });
}

// Seeded waves radiating out from the hero: appearance frame grows with
// distance, batched (quantized) so buildings pop in groups, with per-cell
// jitter so wave fronts read organic, all resolved before the final
// framing settles.
const APPEAR_LAST = Math.round(FRAMES * 0.82);
const POP_FRAMES = 10;
const waveRng = new Rng('grid-waves:v1');
const maxDist = Math.hypot((SIDE / 2) * CELL, (SIDE / 2) * CELL);
for (const p of placed) {
  if (p === placed[0]) {
    // The hero opens the shot fully materialized (its pop would otherwise
    // leave frame 0 with a 2 percent scale speck).
    p.appearFrame = -POP_FRAMES;
    continue;
  }
  const d = Math.hypot(p.pos[0], p.pos[1]) / maxDist;
  const raw = 14 + d * (APPEAR_LAST - 34) + (waveRng.float() * 2 - 1) * 9;
  p.appearFrame = Math.max(1, Math.round(raw / 4) * 4);
}

// ---- 3. camera path --------------------------------------------------------
const FOV = 35;
const heroTarget = [placed[0].pos[0], hero.height * 0.4, placed[0].pos[1]];
const heroRadius = Math.hypot(hero.footprint[0], hero.height, hero.footprint[1]) / 2;
const gridRadius = Math.hypot(SIDE * CELL, SIDE * CELL) / 2;
const d0 = framingDistance(heroRadius, FOV, 16 / 9, 1.25);
// The grid is flat, so fitting its bounding sphere overshoots badly from a
// raised camera; 0.62 of the half-diagonal frames the full grid with a
// modest margin at the final elevation.
const d1 = framingDistance(gridRadius * 0.75, FOV, 16 / 9, 1.05);
const endTarget = [0, 0, 0];
const AZ0 = 0.7;
const AZ_DRIFT = (20 * Math.PI) / 180;
const EL0 = 0.2;
const EL1 = 0.58;

function cameraAt(f) {
  const t = FRAMES === 1 ? 0 : f / (FRAMES - 1);
  const e = smootherstep(t);
  const target = [
    heroTarget[0] + (endTarget[0] - heroTarget[0]) * e,
    heroTarget[1] + (endTarget[1] - heroTarget[1]) * e,
    heroTarget[2] + (endTarget[2] - heroTarget[2]) * e,
  ];
  const dist = d0 + (d1 - d0) * e;
  const az = AZ0 + AZ_DRIFT * t;
  const el = EL0 + (EL1 - EL0) * e;
  return { position: orbitPosition(target, dist, az, el), target, fov: FOV, dist };
}

// ---- 4. render -------------------------------------------------------------
const host = await startRenderHost({ sceneDir: SCENE_DIR, headless: HEADLESS });
await host.initScene({
  groundY: -0.02,
  groundRadius: Math.ceil(gridRadius * 3),
  shadowHalf: 60,
  fogDensity: 0.00025,
});

console.log('[grid] preloading scenes...');
const tLoad = performance.now();
for (let i = 0; i < placed.length; i += 32) {
  await Promise.all(
    placed.slice(i, i + 32).map((p) => host.loadScene(p.file, p.file)),
  );
}
console.log(`[grid] loaded ${placed.length} scenes in ${((performance.now() - tLoad) / 1000).toFixed(1)}s`);

const tRender = performance.now();
const frames = [];
for (let f = 0; f < FRAMES; f++) {
  const cam = cameraAt(f);
  const sceneStates = [];
  let visibleCount = 0;
  for (const p of placed) {
    const dt = f - p.appearFrame;
    const visible = dt >= 0;
    if (visible) visibleCount++;
    const scale = visible ? 0.02 + 0.98 * easeOutCubic(dt / POP_FRAMES) : 0.02;
    sceneStates.push({
      name: p.file,
      visible,
      position: [p.pos[0], 0, p.pos[1]],
      scale,
    });
  }
  const file = `frame_${String(f).padStart(5, '0')}.png`;
  await host.renderFrameTo(
    {
      camera: { position: cam.position, target: cam.target, fov: cam.fov },
      scenes: sceneStates,
      shadow: {
        center: [cam.target[0], cam.target[2]],
        half: Math.min(Math.max(cam.dist * 0.9, 40), gridRadius * 1.5),
      },
    },
    path.join(FRAME_DIR, file),
  );
  frames.push({ frame: f, file, visibleCount, camera: { position: cam.position, target: cam.target, fov: cam.fov } });
  if (f % 30 === 0) console.log(`[grid] rendered frame ${f}/${FRAMES} (${visibleCount} visible)`);
}
await host.close();
const renderMs = performance.now() - tRender;
console.log(`[grid] rendered ${FRAMES} frames in ${(renderMs / 1000).toFixed(1)}s`);

writeFileSync(
  path.join(OUT, 'frames-metadata.json'),
  JSON.stringify({
    pipeline: 'grid',
    fps: FPS,
    width: 1920,
    height: 1080,
    buildingCount: placed.length,
    gridSide: SIDE,
    cellSize: CELL,
    heroSeed: hero.seed,
    meshWallMs: Math.round(meshMs),
    frames,
  }, null, 2),
);

// ---- 5. assemble -----------------------------------------------------------
if (MAKE_VIDEO) {
  assembleMp4(FRAME_DIR, 'frame_%05d.png', FPS, path.join(OUT, 'grid.mp4'));
}

const sampleIdx = [0, 0.2, 0.45, 0.7, 0.88, 1].map((u) => Math.round(u * (FRAMES - 1)));
exportSampleJpgs(
  [...new Set(sampleIdx)].map((i) => path.join(FRAME_DIR, frames[i].file)),
  path.join(__dirname, 'samples'),
  'grid',
);

console.log(`[grid] done. ffmpeg: ${hasFfmpeg() ? 'used' : 'NOT FOUND (command file written)'}`);
console.log(`[grid] output: ${OUT}`);
