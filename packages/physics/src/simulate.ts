/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser/Node simulator built on `@dimforge/rapier3d-compat`.
 *
 * This file mirrors the Rust `ifc-lite-physics` crate one-for-one. Keep them
 * aligned: changes to anchor/joint heuristics belong in both runtimes.
 *
 * Two entry points:
 * - `simulate(...)` runs the whole step loop synchronously. Use it from Node
 *   tests and the Rust-bin equivalents where blocking is fine.
 * - `simulateAsync(...)` chunks stepping behind `setTimeout(0)` yields so
 *   the browser main thread stays responsive on real models. The viewer
 *   uses this path; sync `simulate` would freeze the UI for several
 *   seconds on a few-hundred-body scene.
 *
 * `init()` must be awaited once before either entry point — that's the
 * Rapier WASM module bootstrap.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { aabbCenter, aabbTouches, meshAABB } from './aabb.js';
import { classifyAnchor, densityFor } from './anchor.js';
import {
  type AABB,
  type AnchorReason,
  type BodyOutcome,
  type ColliderStrategy,
  type PhysicsMesh,
  type ResolvedSimulateOptions,
  type SimulateOptions,
  type SimulationResult,
  type Stability,
  resolveOptions,
} from './types.js';

const CONVEX_FRIENDLY_TYPES = new Set([
  'IfcColumn',
  'IfcBeam',
  'IfcMember',
  'IfcFooting',
  'IfcPile',
  'IfcPlate',
]);

/** How many physics steps to run per yield batch in `simulateAsync`. */
const STEPS_PER_YIELD = 4;

let initPromise: Promise<void> | null = null;

/**
 * Initialize the Rapier WASM module. Idempotent — safe to call multiple times.
 *
 * Call once at app startup (or lazily before the first `simulate()`). Without
 * this, Rapier's WASM hasn't booted and constructing a `World` will throw.
 */
export function init(): Promise<void> {
  if (initPromise !== null) {
    return initPromise;
  }
  const p = RAPIER.init();
  initPromise = p;
  return p;
}

interface BodyEntry {
  expressId: number;
  ifcType: string;
  body: RAPIER.RigidBody;
  anchored: boolean;
  anchorReason: AnchorReason | null;
  startTranslation: { x: number; y: number; z: number };
  startRotation: { x: number; y: number; z: number; w: number };
}

interface BuiltWorld {
  world: RAPIER.World;
  entries: BodyEntry[];
  jointPairs: Array<[number, number]>;
  steps: number;
  options: ResolvedSimulateOptions;
}

/**
 * Run a rigid-body simulation synchronously. `init()` must have completed first.
 *
 * Prefer `simulateAsync` in browser contexts — sync stepping freezes the main
 * thread for seconds on real models.
 */
export function simulate(
  meshes: readonly PhysicsMesh[],
  rawOptions?: SimulateOptions,
): SimulationResult {
  const built = buildWorld(meshes, rawOptions);
  try {
    for (let i = 0; i < built.steps; i++) {
      built.world.step();
    }
    return collect(built);
  } finally {
    built.world.free();
  }
}

/**
 * Run a rigid-body simulation, yielding to the event loop between batches of
 * steps so the UI doesn't freeze. Use this in browser hosts.
 */
export async function simulateAsync(
  meshes: readonly PhysicsMesh[],
  rawOptions?: SimulateOptions,
): Promise<SimulationResult> {
  const built = buildWorld(meshes, rawOptions);
  try {
    for (let i = 0; i < built.steps; i++) {
      built.world.step();
      if ((i + 1) % STEPS_PER_YIELD === 0 && i + 1 < built.steps) {
        await yieldToEventLoop();
      }
    }
    return collect(built);
  } finally {
    built.world.free();
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function buildWorld(
  meshes: readonly PhysicsMesh[],
  rawOptions?: SimulateOptions,
): BuiltWorld {
  const options = resolveOptions(rawOptions);
  const removed = new Set(options.remove);
  const explicitAnchors = new Set(options.anchor);
  const anchorTypes = new Set(options.anchorIfcTypes);

  const aabbs = new Map<number, AABB>();
  let modelFloor = Infinity;
  for (const m of meshes) {
    if (removed.has(m.expressId)) continue;
    const box = meshAABB(m);
    if (!box) continue;
    aabbs.set(m.expressId, box);
    if (box.min[2] < modelFloor) modelFloor = box.min[2];
  }
  if (!Number.isFinite(modelFloor)) modelFloor = 0;

  const world = new RAPIER.World({
    x: options.gravity[0],
    y: options.gravity[1],
    z: options.gravity[2],
  });
  world.timestep = Math.max(options.timeStep, 1e-4);

  const entries: BodyEntry[] = [];
  let lowestUnanchored: { id: number; minZ: number } | null = null;

  for (const mesh of meshes) {
    if (removed.has(mesh.expressId)) continue;
    const aabb = aabbs.get(mesh.expressId);
    if (!aabb) continue;
    const reason = classifyAnchor(mesh.expressId, mesh.ifcType, aabb, {
      modelFloor,
      groundTolerance: options.groundAnchorTolerance,
      explicitAnchors,
      anchorTypes,
    });
    const anchored = reason !== null;

    const center = aabbCenter(aabb);
    const desc = anchored ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(center[0], center[1], center[2]);
    // CCD is intentionally off — for plausibility checks elements settle
    // under gravity at low velocities, and CCD doubles per-step work for
    // every dynamic body.
    const body = world.createRigidBody(desc);

    const colliderDesc = buildColliderDesc(mesh, center, options.colliderStrategy);
    if (colliderDesc) {
      colliderDesc.setDensity(densityFor(mesh.ifcType));
      world.createCollider(colliderDesc, body);
    }

    const t = body.translation();
    const r = body.rotation();
    entries.push({
      expressId: mesh.expressId,
      ifcType: mesh.ifcType,
      body,
      anchored,
      anchorReason: reason,
      startTranslation: { x: t.x, y: t.y, z: t.z },
      startRotation: { x: r.x, y: r.y, z: r.z, w: r.w },
    });

    if (!anchored) {
      if (!lowestUnanchored || aabb.min[2] < lowestUnanchored.minZ) {
        lowestUnanchored = { id: mesh.expressId, minZ: aabb.min[2] };
      }
    }
  }

  if (!entries.some((e) => e.anchored) && lowestUnanchored) {
    const fallback = entries.find((e) => e.expressId === lowestUnanchored!.id);
    if (fallback) {
      fallback.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      fallback.anchored = true;
      fallback.anchorReason = 'lowestElement';
    }
  }

  const jointPairs = computeJoints(aabbs, options.adjacencyTolerance, options.connections);
  const handleToBody = new Map<number, RAPIER.RigidBody>();
  for (const e of entries) handleToBody.set(e.expressId, e.body);
  for (const [a, b] of jointPairs) {
    const ba = handleToBody.get(a);
    const bb = handleToBody.get(b);
    if (!ba || !bb) continue;
    // Preserve current relative pose. Default zero anchors would yank
    // far-apart bodies to coincide.
    const ta = ba.translation();
    const tb = bb.translation();
    const offset = { x: ta.x - tb.x, y: ta.y - tb.y, z: ta.z - tb.z };
    const joint = RAPIER.JointData.fixed(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
      offset,
      { x: 0, y: 0, z: 0, w: 1 },
    );
    world.createImpulseJoint(joint, ba, bb, true);
  }

  const totalSeconds = Math.max(options.durationSeconds, 0);
  const steps = Math.ceil(totalSeconds / world.timestep);

  return { world, entries, jointPairs, steps, options };
}

function buildColliderDesc(
  mesh: PhysicsMesh,
  center: [number, number, number],
  strategy: ColliderStrategy,
): RAPIER.ColliderDesc | null {
  const positions = mesh.positions;
  if (!positions || positions.length < 9) return null;
  const indices = mesh.indices;
  if (!indices || indices.length < 3) return null;

  const vertCount = (positions.length / 3) | 0;
  const recentered = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    recentered[i] = positions[i] - center[0];
    recentered[i + 1] = positions[i + 1] - center[1];
    recentered[i + 2] = positions[i + 2] - center[2];
  }

  const resolved = resolveStrategy(strategy, mesh.ifcType);
  if (resolved === 'convexHull') {
    const hull = RAPIER.ColliderDesc.convexHull(recentered);
    if (hull) return hull;
    // convexHull rejects degenerate / coplanar inputs — fall through to
    // trimesh rather than dropping the collider silently.
  }

  const tris: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    if (a < vertCount && b < vertCount && c < vertCount && a !== b && b !== c && a !== c) {
      tris.push(a, b, c);
    }
  }
  if (tris.length === 0) return null;

  return RAPIER.ColliderDesc.trimesh(recentered, new Uint32Array(tris));
}

function resolveStrategy(strategy: ColliderStrategy, ifcType: string): ColliderStrategy {
  if (strategy === 'trimesh' || strategy === 'convexHull') return strategy;
  return CONVEX_FRIENDLY_TYPES.has(ifcType) ? 'convexHull' : 'trimesh';
}

function computeJoints(
  aabbs: Map<number, AABB>,
  eps: number,
  explicit: Array<[number, number]>,
): Array<[number, number]> {
  const seen = new Set<string>();
  const pairs: Array<[number, number]> = [];

  const normalize = (a: number, b: number): [number, number] | null => {
    if (a === b) return null;
    return a < b ? [a, b] : [b, a];
  };

  for (const [a, b] of explicit) {
    const p = normalize(a, b);
    if (!p) continue;
    if (!aabbs.has(p[0]) || !aabbs.has(p[1])) continue;
    const key = `${p[0]}-${p[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push(p);
    }
  }

  const sorted = [...aabbs.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < sorted.length; i++) {
    const [idA, aabbA] = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const [idB, aabbB] = sorted[j];
      if (!aabbTouches(aabbA, aabbB, eps)) continue;
      const p = normalize(idA, idB);
      if (!p) continue;
      const key = `${p[0]}-${p[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push(p);
      }
    }
  }

  return pairs;
}

function collect(built: BuiltWorld): SimulationResult {
  const { entries, jointPairs, options } = built;
  const bodies: BodyOutcome[] = [];
  const stable: number[] = [];
  const falling: number[] = [];
  const tilted: number[] = [];
  const anchored: number[] = [];

  for (const e of entries) {
    const t = e.body.translation();
    const r = e.body.rotation();
    const dx = t.x - e.startTranslation.x;
    const dy = t.y - e.startTranslation.y;
    const dz = t.z - e.startTranslation.z;
    const displacement = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const vertical = dz;

    // Quaternion delta: q_curr * q_start^-1. Pure translation → identity.
    const inv = quatInverse(e.startRotation);
    const delta = quatMul({ x: r.x, y: r.y, z: r.z, w: r.w }, inv);
    const angular = quatAngle(delta);

    let stability: Stability;
    if (e.anchored) {
      stability = 'stable';
    } else if (-vertical > options.fallThreshold || displacement > options.fallThreshold) {
      stability = 'falling';
    } else if (angular > options.tiltThreshold) {
      stability = 'tilted';
    } else {
      stability = 'stable';
    }

    if (stability === 'stable') stable.push(e.expressId);
    else if (stability === 'falling') falling.push(e.expressId);
    else if (stability === 'tilted') tilted.push(e.expressId);
    if (e.anchored) anchored.push(e.expressId);

    bodies.push({
      expressId: e.expressId,
      ifcType: e.ifcType,
      stability,
      anchored: e.anchored,
      anchorReason: e.anchorReason,
      displacement,
      verticalDisplacement: vertical,
      angularDisplacement: angular,
    });
  }

  bodies.sort((a, b) => a.expressId - b.expressId);
  stable.sort((a, b) => a - b);
  falling.sort((a, b) => a - b);
  tilted.sort((a, b) => a - b);
  anchored.sort((a, b) => a - b);

  const removedSorted = [...new Set(options.remove)].sort((a, b) => a - b);

  return {
    bodies,
    removed: removedSorted,
    stable,
    falling,
    tilted,
    anchored,
    joints: jointPairs,
  };
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

function quatInverse(q: Quat): Quat {
  const len2 = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (len2 === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: -q.x / len2, y: -q.y / len2, z: -q.z / len2, w: q.w / len2 };
}

function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function quatAngle(q: Quat): number {
  // 2 * acos(|w|), clamped for numerical safety.
  const w = Math.min(1, Math.max(-1, Math.abs(q.w)));
  return 2 * Math.acos(w);
}
