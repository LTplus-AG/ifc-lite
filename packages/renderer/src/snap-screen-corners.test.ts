/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CAD-style screen-space corner snapping (#11504), through the real
 * `RaycastEngine.raycastSceneMagnetic` with a real orthographic `Camera` and
 * `Scene`. Scale: 15 px per world unit, so the screen position of a corner is
 * (400 + 15 x, 300 - 15 y).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { RaycastEngine } from './raycast-engine.js';
import { Camera } from './camera.js';
import { Scene } from './scene.js';
import { buildGeometryCache } from './snap-geometry-cache.js';
import { ScreenCornerIndex, closestPointOnSegmentToRay, type IdleHost, type IdleSlice } from './snap-screen-corners.js';
import type { Mesh } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 1, INDEX: 2, VERTEX: 4 };

type V3 = [number, number, number];

/** Axis-aligned box as an 8-vertex indexed mesh (vertex bit 0 = x, 1 = y, 2 = z). */
function makeBox(expressId: number, min: V3, max: V3, modelIndex = 0): MeshData {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? max[0] : min[0];
    positions[i * 3 + 1] = i & 2 ? max[1] : min[1];
    positions[i * 3 + 2] = i & 4 ? max[2] : min[2];
  }
  const indices = new Uint32Array([
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4,
    2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
  ]);
  return { expressId, modelIndex, positions, normals: new Float32Array(24), indices, color: [1, 1, 1, 1] };
}

function sceneWith(...boxes: MeshData[]): Scene {
  const scene = new Scene();
  for (const box of boxes) {
    scene.addMeshData(box);
    const mesh: Mesh = {
      expressId: box.expressId, modelIndex: box.modelIndex,
      vertexBuffer: { destroy() {} } as GPUBuffer, indexBuffer: { destroy() {} } as GPUBuffer,
      indexCount: box.indices.length, transform: { m: new Float32Array(16) }, color: box.color,
    };
    scene.addMesh(mesh);
  }
  return scene;
}

function cameraDownZ(): Camera {
  const camera = new Camera();
  camera.setAspect(800 / 600);
  camera.setProjectionMode('orthographic');
  camera.setOrthoSize(20);
  camera.setPosition(0, 0, 50);
  camera.setTarget(0, 0, 0);
  camera.setUp(0, 1, 0);
  return camera;
}

const canvas = { width: 800, height: 600, getBoundingClientRect: () => ({ width: 800, height: 600 }) } as unknown as HTMLCanvasElement;
const lock = { edge: null, meshExpressId: null, lockStrength: 0 };
const base = { snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 4 };
const withCorners = { ...base, screenCornerSnap: { settleMs: 0 } };

/** Idle slices run by hand: nothing happens until `tick` / `drain`. `onWait` advances a fake clock for delayed requests. */
class ManualIdleHost implements IdleHost {
  private queue: { id: number; cb: (s: IdleSlice) => void; afterMs: number }[] = [];
  private next = 1;
  onWait: (ms: number) => void = () => {};
  request(cb: (s: IdleSlice) => void, afterMs = 0): unknown {
    const id = this.next++;
    this.queue.push({ id, cb, afterMs });
    return id;
  }
  cancel(h: unknown): void { this.queue = this.queue.filter((q) => q.id !== h); }
  get pending(): number { return this.queue.length; }
  /** Run the oldest queued slice with `budgetMs` of idle time; false when none was queued. */
  tick(budgetMs = 1e9): boolean {
    const q = this.queue.shift();
    if (!q) return false;
    if (q.afterMs > 0) this.onWait(q.afterMs);
    q.cb({ timeRemaining: () => budgetMs, didTimeout: false });
    return true;
  }
  drain(maxSlices = 100000): number {
    let n = 0;
    while (n < maxSlices && this.tick()) n++;
    return n;
  }
}

/** A pick the way a host sees it: the first pick only starts the idle build, the second one reads what it built. */
function pick(scene: Scene, x: number, y: number, options: Record<string, unknown> = {}, clip?: Parameters<RaycastEngine['raycastSceneMagnetic']>[4]) {
  const host = new ManualIdleHost();
  const snap = (options.snapOptions ?? withCorners) as { screenCornerSnap?: object };
  const snapOptions = snap.screenCornerSnap ? { ...snap, screenCornerSnap: { ...snap.screenCornerSnap, idleHost: host } } : snap;
  const engine = new RaycastEngine(cameraDownZ(), scene, canvas);
  const run = () => engine.raycastSceneMagnetic(x, y, lock, { ...options, snapOptions }, clip);
  run();
  host.drain();
  return run();
}

// Box A top corner (0, 2, 2) projects to (400, 270).
const boxA = () => makeBox(1, [-4, -2, 0], [0, 2, 2]);

describe('screen-space corner snapping (#11504)', () => {
  it('(a) snaps a corner 5 px outside the element, over background', () => {
    const result = pick(sceneWith(boxA()), 405, 265);
    assert.equal(result.intersection, null, 'the ray hits nothing');
    assert.equal(result.snapTarget?.type, 'vertex');
    assert.equal(result.snapTarget?.expressId, 1);
    assert.deepEqual([result.snapTarget?.position.x, result.snapTarget?.position.y, result.snapTarget?.position.z], [0, 2, 2]);
  });

  it('falls back to an edge within 6 px when no corner is within 10 px', () => {
    // Top edge y = 2 runs from x = -4 to 0; (-200 px, ...) mid-edge is far from both ends.
    const result = pick(sceneWith(boxA()), 370, 265);
    assert.equal(result.snapTarget?.type, 'edge');
    assert.ok(Math.abs((result.snapTarget?.position.y ?? 0) - 2) < 1e-6);
    assert.ok(Math.abs((result.snapTarget?.position.x ?? 0) + 2) < 0.01);
    assert.equal(pick(sceneWith(boxA()), 370, 258).snapTarget, null, '12 px off the edge is outside both radii');
  });

  it('(b) a corner of another element wins over the element under the ray', () => {
    // B is taller and sits to the right of A's corner; the cursor is over B,
    // 6.4 px from A's corner (0, 2, 2) and 0.5 px from B's own left edge.
    const scene = sceneWith(boxA(), makeBox(2, [0.3, -2, 0], [4, 4, 1]));
    const result = pick(scene, 405, 274);
    assert.equal(result.intersection?.expressId, 2, 'the ray hits B');
    assert.equal(result.snapTarget?.type, 'vertex');
    assert.equal(result.snapTarget?.expressId, 1);
    assert.deepEqual([result.snapTarget?.position.x, result.snapTarget?.position.y, result.snapTarget?.position.z], [0, 2, 2]);
  });

  it('(c) ignores corners of a model that is not eligible', () => {
    const scene = sceneWith(makeBox(1, [-4, -2, 0], [0, 2, 2], 1));
    const only = (indices: number[]) => ({ snapOptions: { ...base, screenCornerSnap: { settleMs: 0, eligibleModelIndices: new Set(indices) } } });
    assert.equal(pick(scene, 405, 265, only([0])).snapTarget, null);
    assert.equal(pick(scene, 405, 265, only([1])).snapTarget?.type, 'vertex');
  });

  it('(d) ignores corners of hidden entities, and of anything outside the isolated set', () => {
    const scene = sceneWith(boxA());
    assert.equal(pick(scene, 405, 265, { hiddenIds: new Set([1]) }).snapTarget, null);
    assert.equal(pick(scene, 405, 265, { isolatedIds: new Set([99]) }).snapTarget, null);
    assert.equal(pick(scene, 405, 265, { isolatedIds: new Set([1]) }).snapTarget?.type, 'vertex');
  });

  it('(e) ignores a corner the section plane cut away', () => {
    // The plane removes z > 1: the top corner (0, 2, 2) is gone, the bottom one (0, 2, 0) stays.
    const clip = { sectionPlane: { normal: [0, 0, 1] as [number, number, number], distance: 1, flipped: false } };
    const result = pick(sceneWith(boxA()), 405, 265, {}, clip);
    assert.equal(result.snapTarget?.type, 'vertex');
    assert.equal(result.snapTarget?.position.z, 0, 'the kept corner, not the clipped one');
    const gone = pick(sceneWith(makeBox(1, [-4, -2, 2], [0, 2, 4])), 405, 265, {}, clip);
    assert.equal(gone.snapTarget, null, 'every corner of the element is clipped');
  });

  it('(f) changes nothing with snapping off', () => {
    const scene = sceneWith(boxA());
    assert.equal(pick(scene, 405, 265, { snapOptions: base }).snapTarget, null, 'no screenCornerSnap option');
    const off = { ...withCorners, snapToVertices: false, snapToEdges: false };
    assert.equal(pick(scene, 405, 265, { snapOptions: off }).snapTarget, null, 'vertex and edge snapping both off');
    // Over the element the ray-based result is untouched when the option is absent.
    const inside = pick(sceneWith(makeBox(1, [-4, -2, 0], [4, 2, 2])), 400, 300, { snapOptions: base });
    assert.equal(inside.snapTarget?.type, 'face');
  });

  it('skips a corner hidden behind a box unless occlusion is ignored', () => {
    // F (z 4..6) covers A's corner (0, 2, 2) in the view; the ray hits F at depth 44.
    const scene = () => sceneWith(boxA(), makeBox(2, [-1, -3, 4], [3, 3, 6]));
    const shaded = pick(scene(), 405, 265);
    assert.equal(shaded.intersection?.expressId, 2);
    assert.equal(shaded.snapTarget?.expressId, 2, 'the hidden corner of A does not win');
    assert.notEqual(shaded.snapTarget?.type, 'vertex');
    const xray = pick(scene(), 405, 265, { snapOptions: { ...base, screenCornerSnap: { settleMs: 0, ignoreOcclusion: true } } });
    assert.equal(xray.snapTarget?.type, 'vertex');
    assert.deepEqual([xray.snapTarget?.expressId, xray.snapTarget?.position.z], [1, 2]);
  });

  it('keeps the ray-based point when nothing is within the screen radii', () => {
    const inside = pick(sceneWith(makeBox(1, [-4, -2, 0], [4, 2, 2])), 400, 300);
    assert.equal(inside.snapTarget?.type, 'face');
    assert.equal(inside.snapTarget?.position.z, 2);
  });
});

describe('closestPointOnSegmentToRay', () => {
  it('is the segment point nearest the ray, clamped to the segment', () => {
    const ray = { origin: { x: 1, y: 5, z: 10 }, direction: { x: 0, y: 0, z: -1 } };
    assert.deepEqual(closestPointOnSegmentToRay({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, ray), { x: 1, y: 0, z: 0 });
    assert.deepEqual(closestPointOnSegmentToRay({ x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, ray), { x: 2, y: 0, z: 0 });
  });
});

const VIEW = { width: 800, height: 600 };

/** An index over `pieces` with a still camera, a manual idle host and a fake clock; each geometry build costs 1 ms. */
function harness(pieces: MeshData[], options: Record<string, unknown> = {}) {
  const camera = cameraDownZ();
  camera.setOrthoSize(30);
  const index = new ScreenCornerIndex();
  const host = new ManualIdleHost();
  const state = { clock: 0, built: [] as number[], key: 'still' };
  host.onWait = (ms) => { state.clock += ms; };
  const query = (x: number, y: number, extra: Partial<Parameters<ScreenCornerIndex['query']>[0]> = {}) => index.query({
    x, y, ray: camera.unprojectToRay(x, y, VIEW.width, VIEW.height), camera, viewKey: state.key, ...extra,
    liveViewKey: () => state.key, viewport: VIEW, pieces,
    geometryFor: (m) => { state.clock += 1; state.built.push(m.expressId); return buildGeometryCache(m); },
    options: { idleHost: host, settleMs: 100, maxSliceMs: 5, ...options }, now: () => state.clock,
  });
  const at = (wx: number, wy: number, wz = 0.1) => camera.projectToScreen({ x: wx, y: wy, z: wz }, VIEW.width, VIEW.height)!;
  return { index, host, state, query, at, camera };
}

function boxRow(n: number): MeshData[] {
  const pieces: MeshData[] = [];
  for (let i = 0; i < n; i++) pieces.push(makeBox(i + 1, [i * 0.2, 0, 0], [i * 0.2 + 0.1, 0.1, 0.1]));
  return pieces;
}

describe('screen corner idle build (#11504)', () => {
  it('a pick never runs a candidate-build chunk or a grid rebuild; only idle slices do', () => {
    const t = harness(boxRow(100));
    const first = t.at(0, 0);
    // 60 picks over a still camera, idle slices never granted: nothing is built, every answer is null.
    for (let k = 0; k < 60; k++) {
      t.state.clock += 16;
      assert.equal(t.query(first.x, first.y), null);
    }
    assert.equal(t.state.built.length, 0, 'no pick built a candidate');
    assert.equal(t.index.stats()?.gridsStarted, 0, 'no pick started a grid');
    // Idle slices build; picks between slices build nothing and cost no clock.
    t.host.tick(); // the settle wait
    t.host.tick();
    const built = t.state.built.length;
    const grids = t.index.stats()!.gridsStarted;
    assert.ok(built > 0 && grids === 1, `an idle slice built ${built} pieces and started ${grids} grid(s)`);
    for (let k = 0; k < 60; k++) {
      const before = t.state.clock;
      t.query(first.x, first.y);
      assert.equal(t.state.clock, before, 'a pick advanced the clock: it built something');
    }
    assert.equal(t.state.built.length, built, 'picks between slices built no candidate');
    assert.equal(t.index.stats()!.gridsStarted, grids, 'picks between slices started no grid');
    // A camera move starts a new grid only when an idle slice runs on the settled view, never inside a pick.
    t.host.drain();
    const gridsDone = t.index.stats()!.gridsStarted;
    t.state.key = 'moved';
    for (let k = 0; k < 20; k++) { t.state.clock += 16; assert.equal(t.query(first.x, first.y), null, 'the old grid never answers for a new view'); }
    assert.equal(t.index.stats()!.gridsStarted, gridsDone, 'no grid started by picks of the new view');
    t.host.drain();
    assert.equal(t.index.stats()!.gridsStarted, gridsDone + 1, 'the idle slice built the grid for the new view');
    assert.ok(t.query(first.x, first.y), 'and the next pick reads it');
  });

  it('coverage completes over idle ticks, and a pick answers from the part built so far', () => {
    const t = harness(boxRow(100));
    const first = t.at(0, 0), last = t.at(99 * 0.2, 0);
    t.query(first.x, first.y);
    t.host.tick(); // settle wait
    t.host.tick(); // ~5 pieces
    const early = t.index.stats()!;
    assert.ok(early.gridPieces > 0 && early.gridPieces < 20, `partial grid after one slice (${early.gridPieces})`);
    assert.ok(!early.complete);
    let slices = 0;
    while (t.host.tick()) slices++;
    const done = t.index.stats()!;
    assert.ok(slices > 5, `${slices} idle slices`);
    assert.equal(done.complete, true);
    assert.equal(done.gridPieces, 100);
    assert.equal(done.candidatePieces, 100);
    assert.equal(t.query(last.x, last.y)?.expressId, 100, 'the last piece is snappable once coverage is complete');
    assert.equal(t.host.pending, 0, 'a complete build schedules nothing more');
    t.query(first.x, first.y);
    assert.equal(t.host.pending, 0, 'and a pick on the same view does not restart it');
  });

  it('builds the pieces that reach the viewport first, nearest the camera first', () => {
    // Off-screen boxes come first in scene order; on-screen ones are at |x| = 0.5 .. 4.5 from the camera axis.
    const pieces: MeshData[] = [];
    for (let i = 0; i < 10; i++) pieces.push(makeBox(100 + i, [500 + i, 0, 0], [500.1 + i, 0.1, 0.1]));
    const onScreen = [9, 3, 7, 1, 5, 2, 8, 4, 6, 10];
    for (const k of onScreen) pieces.push(makeBox(k, [k * 0.5, 0, 0], [k * 0.5 + 0.1, 0.1, 0.1]));
    const t = harness(pieces);
    t.query(400, 300);
    t.host.drain();
    assert.deepEqual(t.state.built.slice(0, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'on-screen pieces, nearest first');
    assert.deepEqual(t.state.built.slice(10).sort(), Array.from({ length: 10 }, (_, i) => 100 + i), 'then the off-screen ones');
  });

  it('builds a very large piece after the small ones, even when it is nearest', () => {
    const big = makeBox(1, [0, 0, 0], [0.1, 0.1, 0.1]);
    const box = big.indices;
    big.indices = new Uint32Array(box.length * 2000); // 24 000 triangles, over BIG_PIECE_TRIANGLES
    for (let r = 0; r < 2000; r++) big.indices.set(box, r * box.length);
    const t = harness([big, ...[2, 3, 4].map((id) => makeBox(id, [id * 0.5, 0, 0], [id * 0.5 + 0.1, 0.1, 0.1]))]);
    t.query(400, 300);
    t.host.drain();
    assert.deepEqual(t.state.built, [2, 3, 4, 1], 'the big piece waits for the small ones');
  });

  it('does nothing while the view moves, and starts once it has been still for settleMs', () => {
    const t = harness(boxRow(20));
    t.host.onWait = () => {}; // the clock only moves with the picks
    for (let k = 0; k < 10; k++) {
      t.state.key = `v${k}`; // the camera moves between every pick
      t.state.clock += 16;
      t.query(400, 300);
      t.host.tick();
    }
    assert.equal(t.state.built.length, 0, 'nothing built while the view moved every 16 ms');
    t.host.onWait = (ms) => { t.state.clock += ms; };
    t.host.drain();
    assert.equal(t.index.stats()!.complete, true, 'built once the view stopped');
    assert.ok(t.state.clock >= 9 * 16 + 100, 'only after the settle time');
  });

  it('a fresh empty set per pick (hidden ids, section-excluded ids) is not a view change', () => {
    const t = harness(boxRow(20));
    const first = t.at(0, 0);
    // The viewer hands over new, equal, empty sets on every pick; the grid must not restart for them.
    const pick = () => t.query(first.x, first.y, { hiddenIds: new Set<number>(), clip: { sectionExcludedIds: new Set<number>() } });
    pick();
    t.host.drain();
    assert.equal(t.index.stats()!.complete, true);
    for (let k = 0; k < 20; k++) { t.state.clock += 16; assert.ok(pick(), 'the grid still answers'); }
    assert.equal(t.index.stats()!.gridsStarted, 1, 'no new grid for an equal empty set');
    assert.equal(t.host.pending, 0);
  });

  it('stops its idle work when cleared', () => {
    const t = harness(boxRow(20));
    t.query(400, 300);
    assert.equal(t.host.pending, 1);
    t.index.clear();
    assert.equal(t.host.pending, 0);
    assert.equal(t.index.stats(), null);
  });
});

describe('screen corner query cost', () => {
  it('answers a query over ~50k corners in well under a frame', () => {
    // 80 x 79 grid of boxes, 8 corners each: 50.5k feature corners.
    const pieces: MeshData[] = [];
    for (let i = 0; i < 80; i++) {
      for (let j = 0; j < 79; j++) pieces.push(makeBox(i * 100 + j + 1, [i * 0.5, j * 0.5, 0], [i * 0.5 + 0.3, j * 0.5 + 0.3, 0.3]));
    }
    const camera = cameraDownZ();
    camera.setOrthoSize(30);
    const index = new ScreenCornerIndex();
    const host = new ManualIdleHost();
    const ray = camera.unprojectToRay(400, 300, 800, 600);
    const query = (x: number, y: number, viewKey: string) => index.query({
      x, y, ray, camera, viewKey, viewport: VIEW, pieces, geometryFor: (m) => buildGeometryCache(m),
      options: { idleHost: host, settleMs: 0, maxSliceMs: 1e9 },
    });
    query(400, 300, 'v0');
    let t = performance.now();
    host.drain(); // candidates and grid, all in idle slices
    const buildMs = performance.now() - t;
    assert.equal(index.stats()?.complete, true);
    const runs = 200;
    t = performance.now();
    for (let k = 0; k < runs; k++) query(300 + k, 200 + (k % 50), 'v0');
    const perMoveMs = (performance.now() - t) / runs;
    console.log(`screen-corner bench: ${pieces.length * 8} corners; idle build ${buildMs.toFixed(0)} ms, ~${((index.stats()?.approxBytes ?? 0) / 1e6).toFixed(1)} MB; query ${perMoveMs.toFixed(3)} ms (per move)`);
    assert.ok(perMoveMs < 2, `per-move query took ${perMoveMs} ms`);
  });
});
