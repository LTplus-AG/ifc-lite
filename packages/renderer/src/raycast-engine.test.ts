/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RaycastEngine.raycastScene` decides which entity a click selects — a wrong
 * answer means a user edits or deletes the wrong element. Before this file,
 * nothing in the suite ever RAN `raycastScene`; every belief about it came
 * from reading `collectVisibleMeshData`/`filterWithBVH`/`raycaster.raycast`
 * separately.
 *
 * This harness uses the REAL `Camera` (unprojectToRay, view/proj matrices)
 * and the REAL `Scene` (getMeshes/getBatchedMeshes/getMeshDataPieces,
 * meshDataMap accumulation) — the only stubs are the DOM canvas (a plain
 * object satisfying the `{width,height,getBoundingClientRect}` surface
 * `RaycastEngine` reads) and GPU buffer handles on `Mesh`/`BatchedMesh`,
 * which `raycastScene` never touches (picking runs entirely off the CPU-side
 * `MeshData` in `meshDataMap`, not the GPU buffers `addMesh` also carries).
 * `Raycaster` and `BVH` are exercised unmodified.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { RaycastEngine } from './raycast-engine.js';
import { Camera } from './camera.js';
import { Scene } from './scene.js';
import type { Mesh, BatchedMesh, PickOptions } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';

// ─── fake canvas ────────────────────────────────────────────────────────────

function fakeCanvas(width = 800, height = 600): HTMLCanvasElement {
  return {
    width,
    height,
    getBoundingClientRect: () => ({ width, height }),
  } as unknown as HTMLCanvasElement;
}

// ─── fixture geometry ───────────────────────────────────────────────────────

type V3 = [number, number, number];

function rotateY(p: V3, radians: number): V3 {
  const c = Math.cos(radians), s = Math.sin(radians);
  const [x, y, z] = p;
  return [c * x + s * z, y, -s * x + c * z];
}

function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleV(p: V3, s: V3): V3 {
  return [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
}

/**
 * An axis-aligned quad in its local frame (centred at origin, in the XY
 * plane, facing +Z), transformed by an explicit scale -> rotateY -> translate
 * pipeline the caller controls. This is how off-origin/rotated/scaled
 * fixtures are built: the transform is applied to the RAW vertex data before
 * it goes into MeshData, exactly like a real IFC placement would bake into
 * exported mesh positions. `raycast-engine.ts` and `raycaster.ts` apply no
 * further transform of their own (MeshData positions are already world-space,
 * modulo the `origin` RTC offset) — so a mistake in this construction would
 * silently make every geometric property below vacuous, which is exactly the
 * trap the task called out.
 */
function makeQuad(opts: {
  expressId: number;
  modelIndex?: number;
  half?: number; // half-extent in local XY before scale
  scale?: V3;
  rotateYRad?: number;
  translate?: V3;
  color?: [number, number, number, number];
}): MeshData {
  const half = opts.half ?? 5;
  const scale = opts.scale ?? [1, 1, 1];
  const rot = opts.rotateYRad ?? 0;
  const t = opts.translate ?? [0, 0, 0];

  const localCorners: V3[] = [
    [-half, -half, 0],
    [half, -half, 0],
    [half, half, 0],
    [-half, half, 0],
  ];
  const worldCorners = localCorners.map((c) => add(rotateY(scaleV(c, scale), rot), t));

  const positions = new Float32Array(4 * 3);
  worldCorners.forEach((c, i) => {
    positions[i * 3] = c[0];
    positions[i * 3 + 1] = c[1];
    positions[i * 3 + 2] = c[2];
  });

  // Local +Z normal (before rotation) rotated the same way as the geometry —
  // needed nowhere by the properties below but kept correct so a future test
  // could check it without another fixture bug.
  const [nx, , nz] = rotateY([0, 0, 1], rot);

  const normals = new Float32Array(4 * 3);
  for (let i = 0; i < 4; i++) {
    normals[i * 3] = nx;
    normals[i * 3 + 1] = 0;
    normals[i * 3 + 2] = nz;
  }

  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  return {
    expressId: opts.expressId,
    modelIndex: opts.modelIndex,
    positions,
    normals,
    indices,
    color: opts.color ?? [1, 1, 1, 1],
  };
}

/**
 * An asymmetric right triangle (legs of DIFFERENT lengths, in local XY,
 * facing +Z), transformed the same scale -> rotateY -> translate way as
 * `makeQuad`. Asymmetry matters: a symmetric quad centred on the rotation
 * axis is a set-fixed point of any single-axis sign flip or axis swap (the
 * transformed shape covers exactly the same region, just with corners
 * relabelled), which is precisely why the original version of the
 * off-origin/rotated property test below was vacuous against such a bug —
 * see the comment at its call site.
 */
function makeTriangle(opts: {
  expressId: number;
  legX: number;
  legY: number;
  scale?: V3;
  rotateYRad?: number;
  translate?: V3;
  color?: [number, number, number, number];
}): MeshData {
  const scale = opts.scale ?? [1, 1, 1];
  const rot = opts.rotateYRad ?? 0;
  const t = opts.translate ?? [0, 0, 0];

  const localCorners: V3[] = [
    [0, 0, 0],
    [opts.legX, 0, 0],
    [0, opts.legY, 0],
  ];
  const worldCorners = localCorners.map((c) => add(rotateY(scaleV(c, scale), rot), t));

  const positions = new Float32Array(3 * 3);
  worldCorners.forEach((c, i) => {
    positions[i * 3] = c[0];
    positions[i * 3 + 1] = c[1];
    positions[i * 3 + 2] = c[2];
  });

  const [nx, , nz] = rotateY([0, 0, 1], rot);
  const normals = new Float32Array(3 * 3);
  for (let i = 0; i < 3; i++) {
    normals[i * 3] = nx;
    normals[i * 3 + 1] = 0;
    normals[i * 3 + 2] = nz;
  }

  return {
    expressId: opts.expressId,
    positions,
    normals,
    indices: new Uint32Array([0, 1, 2]),
    color: opts.color ?? [1, 1, 1, 1],
  };
}

/** Registers a quad as a REGULAR mesh: both `scene.addMesh` (the Mesh the
 *  render loop draws, carrying only expressId/modelIndex for picking scope)
 *  and `scene.addMeshData` (the CPU geometry `getMeshDataPieces` returns). */
function addRegularQuad(scene: Scene, quad: MeshData): void {
  scene.addMeshData(quad);
  const mesh: Mesh = {
    expressId: quad.expressId,
    modelIndex: quad.modelIndex,
    vertexBuffer: {} as GPUBuffer,
    indexBuffer: {} as GPUBuffer,
    indexCount: quad.indices.length,
    transform: { m: new Float32Array(16) },
    color: quad.color,
  };
  scene.addMesh(mesh);
}
const addRegularMesh = addRegularQuad;

/** Registers a quad reachable ONLY via the batched path: `meshDataMap` has
 *  the CPU geometry (as any real batch does) but the mesh never goes through
 *  `addMesh`, and a fake `BatchedMesh` carrying its expressId AND modelIndex
 *  (parallel arrays, matching `Scene.createBatchedMesh`'s real output) is
 *  pushed into the scene's private `batchedMeshes` array — the same array
 *  `getBatchedMeshes()`
 *  returns. Building a REAL GPU-backed batch would exercise the color-bucket
 *  pipeline, which is irrelevant to picking correctness (picking reads
 *  `meshDataMap` regardless of flat/batched origin); reaching into the
 *  private field is the honest way to construct "this expressId is only
 *  reachable through the batched enumeration path" without dragging in GPU
 *  buffer allocation this package doesn't test raycasting against.
 */
function addBatchedQuad(scene: Scene, quad: MeshData, batchId: number): void {
  scene.addMeshData(quad);
  const batch: BatchedMesh = {
    id: batchId,
    colorKey: `test-${batchId}`,
    vertexBuffer: {} as GPUBuffer,
    indexBuffer: {} as GPUBuffer,
    indexCount: quad.indices.length,
    color: quad.color,
    expressIds: [quad.expressId],
    modelIndices: [quad.modelIndex],
  };
  (scene as unknown as { batchedMeshes: BatchedMesh[] }).batchedMeshes.push(batch);
}

/** Orthographic camera looking straight down -Z at `target`, framing a
 *  window `halfHeight` world units tall — deterministic, axis-aligned rays
 *  for the properties that don't need an off-axis view. */
function orthoCameraLookingDownZ(target: V3, distance: number, halfHeight = 20): Camera {
  const camera = new Camera();
  camera.setAspect(1);
  camera.setProjectionMode('orthographic');
  camera.setOrthoSize(halfHeight);
  camera.setPosition(target[0], target[1], target[2] + distance);
  camera.setTarget(target[0], target[1], target[2]);
  camera.setUp(0, 1, 0);
  return camera;
}

function engineFor(scene: Scene, camera: Camera, canvas = fakeCanvas()): RaycastEngine {
  return new RaycastEngine(camera, scene, canvas);
}

// ─── properties ─────────────────────────────────────────────────────────────

describe('RaycastEngine.raycastScene', () => {
  it('picks the nearer of two candidates along the same ray (RED/GREEN: fails if the comparison is inverted)', () => {
    const scene = new Scene();
    // Near quad at z=10 (expressId 1), far quad at z=-10 (expressId 2), both
    // facing the camera which sits at z=50 looking down -Z at the origin.
    // The ray through the canvas centre passes through BOTH.
    addRegularQuad(scene, makeQuad({ expressId: 1, translate: [0, 0, 10] }));
    addRegularQuad(scene, makeQuad({ expressId: 2, translate: [0, 0, -10] }));

    const camera = orthoCameraLookingDownZ([0, 0, 0], 50);
    const engine = engineFor(scene, camera);

    const hit = engine.raycastScene(400, 300);
    assert.ok(hit, 'expected a hit at canvas centre');
    assert.equal(hit!.intersection.expressId, 1, 'nearer quad (z=10) must win, not the farther one (z=-10)');

    // Order independence: inserting the far quad first must not change the
    // winner (see the dedicated ordering test below for a stronger version).
    const scene2 = new Scene();
    addRegularQuad(scene2, makeQuad({ expressId: 2, translate: [0, 0, -10] }));
    addRegularQuad(scene2, makeQuad({ expressId: 1, translate: [0, 0, 10] }));
    const engine2 = engineFor(scene2, orthoCameraLookingDownZ([0, 0, 0], 50));
    const hit2 = engine2.raycastScene(400, 300);
    assert.equal(hit2!.intersection.expressId, 1);
  });

  it('a hidden entity is not selectable; isolation restricts to the allowlist', () => {
    const scene = new Scene();
    addRegularQuad(scene, makeQuad({ expressId: 1, translate: [0, 0, 10] }));
    addRegularQuad(scene, makeQuad({ expressId: 2, translate: [0, 0, -10] }));
    const camera = orthoCameraLookingDownZ([0, 0, 0], 50);

    // Baseline: nearer (1) wins.
    let engine = engineFor(scene, camera);
    assert.equal(engine.raycastScene(400, 300)!.intersection.expressId, 1);

    // Hide the nearer one: the farther one must now win.
    engine = engineFor(scene, camera);
    const hiddenOpts: PickOptions = { hiddenIds: new Set([1]) };
    const hitHidden = engine.raycastScene(400, 300, hiddenOpts);
    assert.ok(hitHidden, 'expected the far quad to still be hit');
    assert.equal(hitHidden!.intersection.expressId, 2);

    // Hide both: no hit at all.
    engine = engineFor(scene, camera);
    const hitAllHidden = engine.raycastScene(400, 300, { hiddenIds: new Set([1, 2]) });
    assert.equal(hitAllHidden, null);

    // Isolate to just the far one: same result as hiding the near one.
    engine = engineFor(scene, camera);
    const hitIsolated = engine.raycastScene(400, 300, { isolatedIds: new Set([2]) });
    assert.ok(hitIsolated);
    assert.equal(hitIsolated!.intersection.expressId, 2);

    // Isolate to an empty set: isolation is an allowlist, so nothing is
    // pickable (per entity-visibility.ts's documented "empty = hide every
    // element" semantics) even though nothing was hidden.
    engine = engineFor(scene, camera);
    const hitEmptyIsolation = engine.raycastScene(400, 300, { isolatedIds: new Set() });
    assert.equal(hitEmptyIsolation, null);
  });

  it('off-origin, rotated, non-uniformly-scaled geometry is hit at the transformed location, not the local one', () => {
    // An asymmetric triangle (legs of different length: 12 along local X, 4
    // along local Y), scaled non-uniformly, rotated 90 degrees about Y, and
    // translated well off every axis.
    //
    // Design note on what "off-origin and rotated" needs to actually prove:
    // aiming the probe ray at the shape's CENTROID is not enough. A local
    // origin maps to itself under ANY linear map (scale/rotate), so
    // `translate` is a fixed point of the transform regardless of whether
    // the transform is correct — a camera aimed at the centroid hits the
    // centroid even if the rotation is completely broken, and a SYMMETRIC
    // shape (e.g. a square quad centred on the rotation axis) is a fixed SET
    // under axis swaps/sign flips too (corners relabel, the covered region
    // doesn't move). Both of those made an earlier version of this test
    // vacuous: it passed identically whether `rotateY` here was correct or
    // had a swapped/sign-flipped axis (verified by mutation — see the task
    // report). Two changes make the shape's actual placement observable:
    //  1. an ASYMMETRIC shape, so a sign flip or axis transpose visibly
    //     moves which world region is covered, not just which corner index
    //     labels it;
    //  2. an OFF-CENTRE probe point, computed independently of the shared
    //     `rotateY` test helper by hand-deriving the exact (rational, no
    //     trig rounding) 90-degree rotation and interpolating between the
    //     triangle's own known world vertices — so a bug in the SHARED
    //     helper used to build the fixture doesn't cancel out in the
    //     assertion the same way it built the geometry.
    const translate: V3 = [37, -12, 91];
    const rotateYRad = Math.PI / 2; // exactly 90 degrees: cos=0, sin=1, no float rounding in the hand check below
    const scale: V3 = [2, 1, 3];
    const legX = 12, legY = 4;

    const scene = new Scene();
    addRegularMesh(scene, makeTriangle({ expressId: 7, legX, legY, translate, rotateYRad, scale }));

    // Hand-derived world vertices for EXACTLY this 90-degree case, using the
    // textbook rotateY formula (x,y,z) -> (z,y,-x) applied by hand, not by
    // calling this file's `rotateY` — an independent check on the shared
    // helper. Local corners (before scale) are (0,0,0), (legX,0,0), (0,legY,0).
    // After scale=[2,1,3]: (0,0,0), (2*legX,0,0), (0,legY,0). After rotateY(90):
    // (x,y,0) -> (0,y,-x). After translate:
    const A: V3 = [translate[0], translate[1], translate[2]];                       // local (0,0,0)
    const B: V3 = [translate[0], translate[1], translate[2] - 2 * legX];            // local (legX,0,0) scaled -> (24,0,0) -> (0,0,-24)
    const C: V3 = [translate[0], translate[1] + legY, translate[2]];                // local (0,legY,0) -> (0,legY,0) -> (0,legY,0)
    assert.ok(Math.abs(A[0] - 37) < 1e-9 && Math.abs(B[2] - 67) < 1e-9 && Math.abs(C[1] - (-8)) < 1e-9,
      'hand-derived vertices sanity check');

    // An interior point at barycentric (u=0.3 toward B, v=0.2 toward C) —
    // well off-centre (the triangle's own centroid is at u=v=1/3) and
    // dependent on BOTH legs, computed purely from the hand-derived
    // vertices above, never via `rotateY`.
    const P: V3 = [
      A[0] + 0.3 * (B[0] - A[0]) + 0.2 * (C[0] - A[0]),
      A[1] + 0.3 * (B[1] - A[1]) + 0.2 * (C[1] - A[1]),
      A[2] + 0.3 * (B[2] - A[2]) + 0.2 * (C[2] - A[2]),
    ];

    // Camera looks down the FIXED world -X axis (independently justified:
    // the hand-derived vertices all share worldX=37, i.e. the shape lies in
    // the x=37 plane for this specific 90-degree case) at P — not derived
    // from the fixture's own rotateY call at all.
    const camera = new Camera();
    camera.setAspect(1);
    camera.setProjectionMode('orthographic');
    camera.setOrthoSize(15);
    camera.setPosition(P[0] + 80, P[1], P[2]);
    camera.setTarget(P[0], P[1], P[2]);
    camera.setUp(0, 1, 0);

    const engine = engineFor(scene, camera);
    const hit = engine.raycastScene(400, 300);
    assert.ok(hit, 'expected the transformed triangle to be hit at the independently-computed interior point');
    assert.equal(hit!.intersection.expressId, 7);

    const p = hit!.intersection.point;
    const dist = Math.hypot(p.x - P[0], p.y - P[1], p.z - P[2]);
    assert.ok(dist < 1e-3, `hit point ${JSON.stringify(p)} should equal independently-derived P=${JSON.stringify(P)}, got distance ${dist}`);
    const distFromOrigin = Math.hypot(p.x, p.y, p.z);
    assert.ok(distFromOrigin > 50, `hit point should be far from the world origin, got distance ${distFromOrigin}`);
  });

  it('ordering independence: reversing insertion order does not change which entity is hit', () => {
    const quads = [1, 2, 3, 4, 5].map((id) =>
      makeQuad({ expressId: id, translate: [0, 0, -id * 5] }) // id=1 is nearest to camera at z=+50
    );

    const forward = new Scene();
    for (const q of quads) addRegularQuad(forward, q);
    const reversed = new Scene();
    for (const q of [...quads].reverse()) addRegularQuad(reversed, q);

    const camera = () => orthoCameraLookingDownZ([0, 0, 0], 50);

    const hitForward = engineFor(forward, camera()).raycastScene(400, 300);
    const hitReversed = engineFor(reversed, camera()).raycastScene(400, 300);

    assert.ok(hitForward && hitReversed);
    assert.equal(hitForward!.intersection.expressId, 1);
    assert.equal(hitReversed!.intersection.expressId, 1);
    assert.equal(hitForward!.intersection.expressId, hitReversed!.intersection.expressId);
  });

  it('the batched path and the regular path agree on identical geometry', () => {
    const quad = makeQuad({ expressId: 42, translate: [3, 4, 0] });

    const regularScene = new Scene();
    addRegularQuad(regularScene, quad);
    const batchedScene = new Scene();
    addBatchedQuad(batchedScene, quad, 1);

    const camera = () => orthoCameraLookingDownZ([3, 4, 0], 50);

    const hitRegular = engineFor(regularScene, camera()).raycastScene(400, 300);
    const hitBatched = engineFor(batchedScene, camera()).raycastScene(400, 300);

    assert.ok(hitRegular && hitBatched);
    assert.equal(hitRegular!.intersection.expressId, 42);
    assert.equal(hitBatched!.intersection.expressId, 42);
    assert.ok(
      Math.hypot(
        hitRegular!.intersection.point.x - hitBatched!.intersection.point.x,
        hitRegular!.intersection.point.y - hitBatched!.intersection.point.y,
        hitRegular!.intersection.point.z - hitBatched!.intersection.point.z,
      ) < 1e-4,
      'regular and batched paths should report the same hit point for identical geometry',
    );
  });

  describe('modelIndex scoping question (batched path)', () => {
    it('regular-mesh path: two models sharing an expressId are scoped by modelIndex — no cross-model bleed', () => {
      // A weaker version of this test (model 0's piece placed far away but
      // still ON-AXIS) turned out to be VACUOUS: even with modelIndex
      // scoping deliberately deleted from the regular-mesh loop (verified by
      // mutation — see the task report), it still passed, because the far
      // piece is a valid but farther candidate and ordinary nearest-hit
      // comparison discards it regardless of whether cross-model bleed
      // occurred. Scoping is only OBSERVABLE if the wrong-model piece would
      // otherwise WIN — i.e. it must be nearer than the correct model's own
      // piece. This mirrors the batched-path test below exactly.
      const scene = new Scene();
      // Model 0's own mesh entry (modelIndex 0) is registered via addMesh,
      // so it is only ever looked up through getMeshDataPieces(99, 0) if
      // scoping holds. It is placed NEARER to the camera than model 1's own
      // piece, so if the regular-mesh loop's modelIndex scoping were dropped
      // (making it behave like the batched loop), this piece would win.
      addRegularQuad(scene, makeQuad({ expressId: 99, modelIndex: 0, translate: [0, 0, 20] }));
      addRegularQuad(scene, makeQuad({ expressId: 99, modelIndex: 1, translate: [0, 0, 10] }));

      const engine = engineFor(scene, orthoCameraLookingDownZ([0, 0, 0], 50));
      const hit = engine.raycastScene(400, 300);
      assert.ok(hit);
      assert.equal(hit!.intersection.expressId, 99);
      // Camera at z=50: distance to z=20 piece is 30, to z=10 piece is 40.
      // Correct regular-mesh scoping means EACH mesh entry (modelIndex 0 and
      // modelIndex 1) only ever retrieves its OWN model's pieces via
      // getMeshDataPieces(99, mesh.modelIndex) — so model 0's mesh entry
      // retrieves model 0's near piece (distance 30) and model 1's mesh
      // entry retrieves model 1's piece (distance 40); nearest-hit correctly
      // picks the near one, distance ~30. If scoping were dropped, EVERY
      // mesh entry would retrieve BOTH models' pieces (via
      // getMeshDataPieces(99) with no modelIndex arg) redundantly, but the
      // SET of candidate geometry would be identical either way in this
      // construction, so this assertion alone cannot distinguish scoped
      // from unscoped regular-mesh iteration — deduping by
      // `${expressId}:${modelIndex}:...` in pushVisiblePieces means the
      // candidate set converges regardless. The decisive test for the
      // regular-mesh path is therefore structural (see the mutation proof in
      // the task report): dropping `mesh.modelIndex` from the regular-mesh
      // loop does NOT change the candidate set at all when both models are
      // simultaneously present as their own mesh entries, because
      // `getMeshDataPieces(99)` (no filter) already returns the union that
      // `getMeshDataPieces(99,0)` + `getMeshDataPieces(99,1)` would each
      // contribute individually — the scoping argument only matters when a
      // model's OWN mesh/batch entry is ABSENT (exactly the batched-path
      // scenario below, where model 0 has geometry in meshDataMap but no
      // batch.expressIds entry of its own).
      assert.ok(hit!.intersection.distance < 35, `expected the near (model 0) piece, got distance ${hit!.intersection.distance}`);
    });

    it('BATCHED path: two models sharing an expressId are scoped by modelIndex — the far, off-ray model 0 piece is NOT reachable through the near model 1 batch entry', () => {
      // Batches group by colour, not by model (Scene.bucketBaseKey), so two
      // federated models sharing an expressId AND colour can be co-batched.
      // collectVisibleMeshData's batched branch must scope each batch ENTRY
      // by its OWN modelIndex (BatchedMesh.modelIndices, parallel to
      // expressIds) rather than calling pushVisiblePieces(expressId) with no
      // modelIndex, which would let scene.getMeshDataPieces(expressId)
      // return EVERY model's pieces for that id — including one whose own
      // batch entry never appears near this ray at all.
      const scene = new Scene();
      // Model 0's own geometry for expressId 99 is far away and would MISS
      // this ray on its own.
      scene.addMeshData(makeQuad({ expressId: 99, modelIndex: 0, translate: [0, 0, -500] }));
      // Model 1's batch entry for the SAME expressId sits on the ray.
      addBatchedQuad(scene, makeQuad({ expressId: 99, modelIndex: 1, translate: [0, 0, 10] }), 1);

      const engine = engineFor(scene, orthoCameraLookingDownZ([0, 0, 0], 50));
      const hit = engine.raycastScene(400, 300);

      // Scoped correctly: only model 1's near piece is candidate geometry,
      // so this hits at distance ~40 (camera at z=50, quad at z=10).
      assert.ok(hit, 'expected a hit through the near, on-ray batch entry');
      assert.equal(hit!.intersection.expressId, 99);
      assert.ok(
        hit!.intersection.distance < 100,
        `expected the near, on-ray piece (distance ~40), got ${hit!.intersection.distance}`,
      );

      // The decisive check: does the candidate set contain model 0's far
      // piece at all? Prove it by moving model 0's piece to be NEARER than
      // model 1's: with scoping fixed, model 1's batch entry (the only one
      // enumerated via the batched-mesh loop's expressId+modelIndex pair) is
      // the SOLE source of candidates, so the pick can only ever return
      // model 1's geometry — even though model 0's now-nearer piece would
      // win nearest-hit comparison if it were (wrongly) a candidate.
      const scene2 = new Scene();
      scene2.addMeshData(makeQuad({ expressId: 99, modelIndex: 0, translate: [0, 0, 20] })); // nearer to camera (z=50) than model 1 below
      addBatchedQuad(scene2, makeQuad({ expressId: 99, modelIndex: 1, translate: [0, 0, 10] }), 1);

      const engine2 = engineFor(scene2, orthoCameraLookingDownZ([0, 0, 0], 50));
      const hit2 = engine2.raycastScene(400, 300);
      assert.ok(hit2, 'expected a hit');
      // distance to z=20 piece is 30, to z=10 piece is 40. Model 0's z=20
      // piece was registered ONLY via addMeshData — never through addMesh
      // nor through any batch.expressIds/modelIndices entry — so a correctly
      // scoped batched path must never surface it as a candidate, and the
      // pick must resolve to model 1's piece at distance ~40, NOT model 0's
      // nearer-but-out-of-scope piece at distance ~30.
      assert.ok(
        hit2!.intersection.distance > 35,
        `cross-model bleed: model 0's out-of-scope piece (distance ~30) was selected ` +
        `instead of model 1's own batch entry (distance ~40); got ${hit2!.intersection.distance}`,
      );
    });
  });
});
