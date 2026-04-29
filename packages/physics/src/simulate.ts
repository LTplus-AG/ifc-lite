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
  type SimulationTrajectory,
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
  /**
   * Stable body identifier owned by the world. We deliberately store the
   * handle (a numeric id) rather than the `RigidBody` wrapper because
   * holding wrappers across `world.free()` triggers wasm-bindgen's
   * "attempted to take ownership of Rust value while it was borrowed"
   * panic. Look bodies up via `world.bodies.get(handle)` on demand.
   */
  handle: RAPIER.RigidBodyHandle;
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
  const recorder = createRecorder(built);
  try {
    if (recorder) recorder.recordFrame(0);
    for (let i = 0; i < built.steps; i++) {
      built.world.step();
      if (recorder) recorder.recordFrame(i + 1);
    }
    // recordFrame is a no-op when the loop already covered this step on a
    // stride boundary; otherwise it captures the terminal pose so the
    // trajectory ends on the exact state `collect` classifies on.
    if (recorder && built.steps > 0) recorder.recordFrame(built.steps);
    return collect(built, recorder?.finalize());
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
  const recorder = createRecorder(built);
  try {
    if (recorder) recorder.recordFrame(0);
    for (let i = 0; i < built.steps; i++) {
      built.world.step();
      if (recorder) recorder.recordFrame(i + 1);
      if ((i + 1) % STEPS_PER_YIELD === 0 && i + 1 < built.steps) {
        await yieldToEventLoop();
      }
    }
    if (recorder && built.steps > 0) recorder.recordFrame(built.steps);
    return collect(built, recorder?.finalize());
  } finally {
    built.world.free();
  }
}

interface TrajectoryRecorder {
  /** Step index after the most recent world.step(). 0 = initial pose. */
  recordFrame(stepIndex: number): void;
  finalize(): SimulationTrajectory;
}

function createRecorder(built: BuiltWorld): TrajectoryRecorder | null {
  const { options, entries, steps } = built;
  if (!options.captureTrajectory) return null;
  const stride = Math.max(1, options.trajectoryStride | 0);

  // We always record frame 0 (initial), each stride boundary, AND the
  // terminal step when steps doesn't divide cleanly into stride — so the
  // last recorded pose matches the state `collect` classifies on.
  const needsTerminalFrame = steps > 0 && steps % stride !== 0;
  const frameCount =
    1 + Math.floor(steps / stride) + (needsTerminalFrame ? 1 : 0);
  const bodyCount = entries.length;
  const poses = new Float32Array(frameCount * bodyCount * 7);
  const bodyOrder = entries.map((e) => e.expressId);
  let nextFrameIndex = 0;

  return {
    recordFrame(stepIndex: number) {
      // Step 0 = initial state; subsequent steps recorded only when on a
      // stride boundary AND we still have room in the pre-allocated buffer.
      // The simulator also explicitly calls us with `stepIndex === built.steps`
      // when the run ended off a stride boundary, so the trajectory's
      // final pose matches what `collect` classifies on.
      const onBoundary = stepIndex === 0 || stepIndex % stride === 0;
      if (!onBoundary && stepIndex !== built.steps) return;
      if (nextFrameIndex >= frameCount) return;
      const base = nextFrameIndex * bodyCount * 7;
      for (let b = 0; b < bodyCount; b++) {
        const e = entries[b];
        const body = built.world.bodies.get(e.handle);
        if (!body) continue;
        const t = body.translation();
        const r = body.rotation();
        const o = base + b * 7;
        poses[o] = t.x;
        poses[o + 1] = t.y;
        poses[o + 2] = t.z;
        poses[o + 3] = r.x;
        poses[o + 4] = r.y;
        poses[o + 5] = r.z;
        poses[o + 6] = r.w;
      }
      nextFrameIndex++;
    },
    finalize() {
      // If the run was shorter than expected (rare — happens if duration
      // was 0), trim the buffer so `frameCount` matches the truth.
      if (nextFrameIndex < frameCount) {
        const trimmed = poses.slice(0, nextFrameIndex * bodyCount * 7);
        return {
          frameCount: nextFrameIndex,
          frameDt: built.world.timestep * stride,
          bodyOrder,
          poses: trimmed,
        };
      }
      return {
        frameCount,
        frameDt: built.world.timestep * stride,
        bodyOrder,
        poses,
      };
    },
  };
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

  // The renderer can be Y-up while IFC convention is Z-up. Pick the AABB
  // axis whose negative direction gravity points along; everything else
  // (floor, ground anchoring, fall classification) keys off this.
  const downAxis = gravityDownAxis(options.gravity);

  const aabbs = new Map<number, AABB>();
  let modelFloor = Infinity;
  for (const m of meshes) {
    if (removed.has(m.expressId)) continue;
    const box = meshAABB(m);
    if (!box) continue;
    aabbs.set(m.expressId, box);
    if (box.min[downAxis] < modelFloor) modelFloor = box.min[downAxis];
  }
  if (!Number.isFinite(modelFloor)) modelFloor = 0;

  const world = new RAPIER.World({
    x: options.gravity[0],
    y: options.gravity[1],
    z: options.gravity[2],
  });
  world.timestep = Math.max(options.timeStep, 1e-4);

  const entries: BodyEntry[] = [];
  let lowestUnanchored: { id: number; along: number } | null = null;
  // Body wrappers held only during the build phase. We need the wrapper
  // for collider parenting and joint anchor reads, but they must NOT
  // leak past the end of buildWorld — wasm-bindgen treats live wrapper
  // references as borrows and `world.free()` panics when one is alive.
  const tempBodies = new Map<number, RAPIER.RigidBody>();

  for (const mesh of meshes) {
    if (removed.has(mesh.expressId)) continue;
    const aabb = aabbs.get(mesh.expressId);
    if (!aabb) continue;
    const reason = classifyAnchor(mesh.expressId, mesh.ifcType, aabb, {
      modelFloor,
      groundTolerance: options.groundAnchorTolerance,
      downAxis,
      explicitAnchors,
      anchorTypes,
    });
    const anchored = reason !== null;

    const center = aabbCenter(aabb);
    const desc = anchored ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(center[0], center[1], center[2]);
    // CCD is intentionally off — plausibility checks settle at low
    // velocities and CCD doubles per-step solver work.
    const body = world.createRigidBody(desc);

    const colliderDesc = buildColliderDesc(mesh, center, options.colliderStrategy);
    if (colliderDesc) {
      colliderDesc.setDensity(densityFor(mesh.ifcType));
      world.createCollider(colliderDesc, body);
    }

    const t = body.translation();
    const r = body.rotation();
    const handle = body.handle;
    entries.push({
      expressId: mesh.expressId,
      ifcType: mesh.ifcType,
      handle,
      anchored,
      anchorReason: reason,
      startTranslation: { x: t.x, y: t.y, z: t.z },
      startRotation: { x: r.x, y: r.y, z: r.z, w: r.w },
    });
    tempBodies.set(mesh.expressId, body);

    if (!anchored) {
      const along = aabb.min[downAxis];
      if (!lowestUnanchored || along < lowestUnanchored.along) {
        lowestUnanchored = { id: mesh.expressId, along };
      }
    }
  }

  if (!entries.some((e) => e.anchored) && lowestUnanchored) {
    const fallback = entries.find((e) => e.expressId === lowestUnanchored!.id);
    if (fallback) {
      const fallbackBody = tempBodies.get(fallback.expressId);
      if (fallbackBody) {
        fallbackBody.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      }
      fallback.anchored = true;
      fallback.anchorReason = 'lowestElement';
    }
  }

  const jointPairs = computeJoints(aabbs, options.adjacencyTolerance, options.connections);
  for (const [a, b] of jointPairs) {
    const ba = tempBodies.get(a);
    const bb = tempBodies.get(b);
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
    const impulseJoint = world.createImpulseJoint(joint, ba, bb, true);
    // IFC tessellation routinely shares vertices between adjacent walls,
    // slabs and columns, so welded bodies start out interpenetrating. The
    // joint says "stay together" while the contact resolver says "get
    // apart" — those huge corrective impulses send the model exploding
    // upward. Disabling contacts on welded pairs lets the joint constraint
    // win cleanly. Pairs that aren't welded still collide as normal.
    impulseJoint.setContactsEnabled(false);
  }
  // Drop every wrapper so the world owns the only references when callers
  // eventually free it.
  tempBodies.clear();

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

function collect(
  built: BuiltWorld,
  trajectory?: SimulationTrajectory,
): SimulationResult {
  const { entries, jointPairs, options } = built;
  const downAxis = gravityDownAxis(options.gravity);
  const bodies: BodyOutcome[] = [];
  const stable: number[] = [];
  const falling: number[] = [];
  const tilted: number[] = [];
  const anchored: number[] = [];

  for (const e of entries) {
    const body = built.world.bodies.get(e.handle);
    if (!body) continue;
    const t = body.translation();
    const r = body.rotation();
    const dx = t.x - e.startTranslation.x;
    const dy = t.y - e.startTranslation.y;
    const dz = t.z - e.startTranslation.z;
    const displacement = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // `vertical` is positive = up, negative = fell, regardless of which
    // axis is "up" in the caller's frame.
    const vertical = downAxis === 0 ? dx : downAxis === 1 ? dy : dz;

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
    trajectory,
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

/**
 * Pick the AABB axis that gravity points along (0=X, 1=Y, 2=Z).
 *
 * IFC convention is Z-up so gravity defaults to `[0, 0, -9.81]` and this
 * returns 2. The viewer pipeline converts geometry to Y-up, so callers
 * passing `[0, -9.81, 0]` get axis 1. Floor / ground-touch / fall
 * heuristics use this axis instead of hardcoded Z.
 */
function gravityDownAxis(gravity: readonly [number, number, number]): 0 | 1 | 2 {
  let idx: 0 | 1 | 2 = 2;
  let val = gravity[2];
  if (gravity[0] < val) {
    idx = 0;
    val = gravity[0];
  }
  if (gravity[1] < val) {
    idx = 1;
  }
  return idx;
}
