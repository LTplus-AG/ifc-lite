#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pipeline 1 - trajectory morph: "gradient descent designs a building".
 *
 * Re-runs the certified diff-spike optimizer (scripts/moonshot/diff-spike),
 * captures parameter snapshots on a start-heavy log-spaced schedule,
 * materializes each snapshot as real IFC via buildIfc, meshes it with the
 * wasm GeometryProcessor, and renders one clean 1920x1080 frame per
 * snapshot with a slowly orbiting camera (~25 degrees over the sequence).
 * No overlays; frames-metadata.json carries per-frame carbon / step /
 * active-constraint data so post can drive counters.
 *
 * Usage:
 *   node scripts/moonshot/video/pipeline-morph.mjs \
 *     [--out DIR] [--snapshots 200] [--fps 30] [--headed] [--no-video]
 *
 * Outputs (under --out, default <scratchpad>/video/morph or
 * $VIDEO_OUT_DIR/morph):
 *   scenes/snap_XXXX.bin   per-snapshot merged geometry
 *   frames/frame_XXXXX.png rendered frames
 *   frames-metadata.json   per-frame carbon, step index, constraints, camera
 *   morph.mp4              (when ffmpeg is available)
 */

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { optimize } from '../diff-spike/optimize.mjs';
import { PARAMS, evaluateNumeric } from '../diff-spike/carbon-model.mjs';
import { buildIfc, REPO_ROOT } from '../diff-spike/build-ifc.mjs';
import { serializeScene, unionBounds } from './lib/scene-bin.mjs';
import { startRenderHost, orbitPosition, framingDistance } from './lib/render-host.mjs';
import { hasFfmpeg, assembleMp4, exportSampleJpgs, defaultOutRoot } from './lib/assemble.mjs';

const { GeometryProcessor } = await import(
  path.join(REPO_ROOT, 'packages/geometry/dist/index.js')
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- args ------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const OUT = path.resolve(args.out ?? path.join(defaultOutRoot(), 'morph'));
const N_SNAPSHOTS = parseInt(args.snapshots ?? '200', 10);
const FPS = parseInt(args.fps ?? '30', 10);
const HEADLESS = !args.headed;
const MAKE_VIDEO = !args['no-video'];

const SCENE_DIR = path.join(OUT, 'scenes');
const FRAME_DIR = path.join(OUT, 'frames');
mkdirSync(SCENE_DIR, { recursive: true });
mkdirSync(FRAME_DIR, { recursive: true });

// Studio palette keyed on the diff-spike material mapping (the authored IFC
// carries no surface styles, so the kernel's default grey is replaced here).
const MATERIAL_COLORS = {
  Concrete: [0.62, 0.6, 0.57, 1],
  Brick: [0.78, 0.6, 0.5, 1],
  Gypsum: [0.88, 0.86, 0.82, 1],
  Timber: [0.65, 0.48, 0.34, 1],
  Glass: [0.55, 0.7, 0.8, 0.35],
};
const DEFAULT_COLOR = [0.7, 0.68, 0.65, 1];

// ---- 1. optimizer run with trajectory capture ------------------------------
console.log('[morph] running diff-spike optimizer...');
const tOpt = performance.now();
const startX = PARAMS.map((p) => (p.lo + p.hi) / 2);
const steps = []; // accepted iterates in order
optimize({
  onAccept: (rec) => {
    steps.push({ x: rec.newX, mu: rec.mu, carbon: rec.carbonAfter });
  },
});
const optMs = performance.now() - tOpt;
console.log(`[morph] optimizer: ${steps.length} accepted steps in ${(optMs / 1000).toFixed(1)}s`);

// Trajectory = start point + accepted iterates.
const traj = [{ x: startX, mu: 10, carbon: evaluateNumeric(startX).carbon }, ...steps];
const M = traj.length - 1;

// Start-heavy log-spaced snapshot schedule over [0, M]. Early steps are where
// the design visibly changes; later steps refine mm-scale dimensions.
function schedule(n) {
  const idx = new Set([0, M]);
  for (let i = 0; i < n * 3; i++) {
    const u = i / (n * 3 - 1);
    idx.add(Math.min(M, Math.round(Math.exp(Math.log(1 + M) * u)) - 1));
    if (idx.size >= n) break;
  }
  return [...idx].sort((a, b) => a - b);
}
const snapIdx = schedule(Math.min(N_SNAPSHOTS, M + 1));
console.log(`[morph] ${snapIdx.length} snapshots over ${M + 1} trajectory points`);

// ---- 2. build + mesh every snapshot ----------------------------------------
const processor = new GeometryProcessor();
await processor.init();

// Silence the wasm pipeline's per-model stdout chatter for the batch.
const realLog = console.log.bind(console);
const quiet = (fn) => {
  console.log = (...a) => {
    if (typeof a[0] === 'string' && a[0].startsWith('[IFC-LITE]')) return;
    realLog(...a);
  };
  return fn().finally(() => { console.log = realLog; });
};

const tMesh = performance.now();
const snapshots = [];
let allBounds = null;
await quiet(async () => {
  for (let s = 0; s < snapIdx.length; s++) {
    const ti = snapIdx[s];
    const { x, mu } = traj[ti];
    const { content, mapping } = buildIfc(x);
    const materialOf = new Map(mapping.map((m) => [m.expressId, m.material]));
    const res = await processor.process(new TextEncoder().encode(content));
    const colorFor = (mesh) => {
      const mat = materialOf.get(mesh.expressId);
      return MATERIAL_COLORS[mat] ?? DEFAULT_COLOR;
    };
    // Re-base each snapshot on its own footprint centre (x/z only; ground
    // level stays put): the design is authored from a fixed origin corner,
    // so without this the building slides toward that corner as the
    // optimizer shrinks it, instead of morphing in place.
    const probe = serializeScene(res.meshes, colorFor);
    const pb = probe.header.bounds;
    const { buffer, header } = serializeScene(res.meshes, colorFor, {
      offset: [-(pb.min[0] + pb.max[0]) / 2, 0, -(pb.min[2] + pb.max[2]) / 2],
    });
    const file = `snap_${String(s).padStart(4, '0')}.bin`;
    writeFileSync(path.join(SCENE_DIR, file), buffer);
    const n = evaluateNumeric(x);
    snapshots.push({
      snapshot: s,
      stepIndex: ti,
      mu,
      file,
      carbon: n.carbon,
      maxViol: Math.max(0, ...n.constraints.map((c) => c.g)),
      activeConstraints: n.constraints.filter((c) => c.g > -1e-3).map((c) => c.name),
      bounds: header.bounds,
    });
    allBounds = unionBounds(allBounds, header.bounds);
    if (s % 25 === 0) realLog(`[morph] meshed snapshot ${s}/${snapIdx.length}`);
  }
});
console.log(`[morph] meshing: ${snapIdx.length} models in ${((performance.now() - tMesh) / 1000).toFixed(1)}s`);
console.log(`[morph] carbon ${snapshots[0].carbon.toFixed(0)} -> ${snapshots.at(-1).carbon.toFixed(0)} kgCO2e`);

// ---- 3. camera path over the union bounds ----------------------------------
const FOV = 32;
const b = allBounds;
const center = [
  (b.min[0] + b.max[0]) / 2,
  // Bias the look-at slightly below the vertical centre; reads better than
  // dead-centre for architecture.
  b.min[1] + (b.max[1] - b.min[1]) * 0.42,
  (b.min[2] + b.max[2]) / 2,
];
const radius = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
const dist = framingDistance(radius, FOV, 16 / 9, 1.1);
const AZ0 = -0.55;
const AZ_SWEEP = (25 * Math.PI) / 180;
const ELEV = 0.3;

// ---- 4. render -------------------------------------------------------------
const host = await startRenderHost({ sceneDir: SCENE_DIR, headless: HEADLESS });
await host.initScene({
  groundY: -0.02,
  groundRadius: 900,
  shadowHalf: Math.ceil(radius * 1.6),
  fogDensity: 0.004,
});

console.log('[morph] preloading scenes...');
for (const s of snapshots) await host.loadScene(s.file, s.file);

const tRender = performance.now();
const frames = [];
let prevScene = null;
for (let f = 0; f < snapshots.length; f++) {
  const snap = snapshots[f];
  const t = snapshots.length === 1 ? 0 : f / (snapshots.length - 1);
  const az = AZ0 + AZ_SWEEP * t;
  const camera = {
    position: orbitPosition(center, dist, az, ELEV),
    target: center,
    fov: FOV,
  };
  const sceneStates = [{ name: snap.file, visible: true }];
  if (prevScene && prevScene !== snap.file) sceneStates.push({ name: prevScene, visible: false });
  const file = `frame_${String(f).padStart(5, '0')}.png`;
  await host.renderFrameTo(
    {
      camera,
      scenes: sceneStates,
      shadow: { center: [center[0], center[2]], half: Math.ceil(radius * 1.6) },
    },
    path.join(FRAME_DIR, file),
  );
  prevScene = snap.file;
  frames.push({
    frame: f,
    file,
    snapshot: snap.snapshot,
    stepIndex: snap.stepIndex,
    mu: snap.mu,
    carbon: snap.carbon,
    maxViol: snap.maxViol,
    activeConstraints: snap.activeConstraints,
    camera,
  });
  if (f % 30 === 0) console.log(`[morph] rendered frame ${f}/${snapshots.length}`);
}
await host.close();
const renderMs = performance.now() - tRender;
console.log(`[morph] rendered ${frames.length} frames in ${(renderMs / 1000).toFixed(1)}s`);

writeFileSync(
  path.join(OUT, 'frames-metadata.json'),
  JSON.stringify({
    pipeline: 'morph',
    fps: FPS,
    width: 1920,
    height: 1080,
    trajectoryPoints: M + 1,
    optimizerWallMs: Math.round(optMs),
    frames,
  }, null, 2),
);

// ---- 5. assemble -----------------------------------------------------------
if (MAKE_VIDEO) {
  assembleMp4(FRAME_DIR, 'frame_%05d.png', FPS, path.join(OUT, 'morph.mp4'));
}

// Commit-sized sample frames (jpg q80) into the repo samples dir.
const sampleIdx = [0, 0.12, 0.3, 0.55, 0.8, 1].map((u) =>
  Math.round(u * (frames.length - 1)));
exportSampleJpgs(
  [...new Set(sampleIdx)].map((i) => path.join(FRAME_DIR, frames[i].file)),
  path.join(__dirname, 'samples'),
  'morph',
);

console.log(`[morph] done. ffmpeg: ${hasFfmpeg() ? 'used' : 'NOT FOUND (command file written)'}`);
console.log(`[morph] output: ${OUT}`);
