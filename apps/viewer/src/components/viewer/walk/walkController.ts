/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Walk mode in the viewport: owns a {@link WalkSession} for as long as the
 * Walk tool is active, steps it every animation frame from the held keys, and
 * writes the eye back to the camera.
 *
 * The camera stays the source of truth for where the user LOOKS (mouse look
 * edits its target); the session is the source of truth for where they
 * STAND. Anything else that moves the camera (zoom, a preset view, framing a
 * selection) is treated as a teleport: the walker is set down again from the
 * new eye.
 */

import type { Renderer, SceneContents } from '@ifc-lite/renderer';
import { WalkCollisionWorld, type WalkGeometrySource } from './walkCollisionWorld.js';
import { prefetchAround } from './walkPrefetch.js';
import { WalkSession, type Vec3, type WalkInput, type WalkSpawn } from './walkSession.js';
import { walkStatusStore } from './walkStatusStore.js';
import { flySpeedStore } from '../flySpeedStore.js';

/** Prefetch budget per frame, in ms: a sliver of a 60 Hz frame. */
const PREFETCH_MS = 2;
/** The scene is re-checked for added/removed geometry this often (frames). */
const SCENE_CHECK_FRAMES = 30;
/** Never rebuild the entity index more often than this while a model streams in. */
const MIN_REBUILD_MS = 2000;
/** Camera moves larger than this between frames were not ours: re-spawn. */
const EXTERNAL_MOVE = 0.02;

export interface WalkController {
  setKey(key: string, down: boolean): void;
  queueJump(): void;
  togglePhysics(): void;
  dispose(): void;
}

/** The scene's resident geometry, flat and instanced, as the collision world reads it. */
export function sceneWalkSource(scene: SceneContents): WalkGeometrySource {
  return {
    entityIds: () => scene.getAllMeshDataExpressIds(),
    bounds: (id) => scene.getEntityBoundingBox(id) ?? scene.getInstancedEntityBounds(id),
    pieces: (id) => {
      const flat = scene.getMeshDataPieces(id);
      if (!scene.isInstancedEntity(id)) return flat;
      const instanced = scene.getInstancedMeshDataPieces(id);
      return flat && instanced ? [...flat, ...instanced] : flat ?? instanced;
    },
  };
}

const sceneSignature = (scene: SceneContents): string =>
  `${scene.getBatchedMeshes().length}:${scene.getMeshes().length}:${scene.getInstancedEntityCount()}`;

export function createWalkController(renderer: Renderer, collidable: (id: number) => boolean): WalkController {
  const camera = renderer.getCamera();
  const scene = renderer.getScene();
  const keys = new Set<string>();
  let world: WalkCollisionWorld | null = null;
  let session: WalkSession | null = null;
  let signature = '';
  let builtAt = -Infinity;
  let lastEye: Vec3 | null = null;
  let lastSpawn: { outcome: WalkSpawn; eye: Vec3; look: Vec3 } | null = null;
  let lastTime = performance.now();
  let frame = 0;
  let raf = 0;
  let disposed = false;

  const look = (): Vec3 => {
    const p = camera.getPosition();
    const t = camera.getTarget();
    return { x: t.x - p.x, y: t.y - p.y, z: t.z - p.z };
  };

  /** Set the walker down from the camera's current eye, levelling the view. */
  const spawn = (): void => {
    if (!session) return;
    const eye = camera.getPosition();
    const dir = look();
    lastSpawn = { outcome: session.spawn(eye, dir), eye: { ...eye }, look: dir };
    const flat = Math.hypot(dir.x, dir.z);
    const hx = flat > 1e-6 ? dir.x / flat : 0;
    const hz = flat > 1e-6 ? dir.z / flat : -1;
    const distance = Math.min(20, Math.max(2, Math.hypot(dir.x, dir.y, dir.z)));
    lastEye = null;
    apply(session.frame(0, { forward: 0, right: 0, run: false, jump: false, crouch: false }, dir), { x: hx * distance, y: 0, z: hz * distance });
  };

  const build = (): void => {
    const start = performance.now();
    world = new WalkCollisionWorld(sceneWalkSource(scene), { collidable });
    const physics = session?.physics ?? true;
    session = new WalkSession(world);
    session.physics = physics;
    signature = sceneSignature(scene);
    builtAt = performance.now();
    console.log(`[Walk] indexed ${world.stats.entities} entities in ${(builtAt - start).toFixed(1)} ms`);
  };

  /** Move the camera to the eye, keeping the look direction (or using `dir`). */
  const apply = (eye: Vec3, dir: Vec3 = look()): void => {
    if (lastEye && Math.abs(eye.x - lastEye.x) + Math.abs(eye.y - lastEye.y) + Math.abs(eye.z - lastEye.z) < 1e-6) return;
    camera.setPosition(eye.x, eye.y, eye.z);
    camera.setTarget(eye.x + dir.x, eye.y + dir.y, eye.z + dir.z);
    lastEye = { ...eye };
    renderer.requestRender();
  };

  const input = (): WalkInput => ({
    forward: (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0),
    right: (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0),
    run: keys.has('shift'),
    jump: keys.has(' '),
    crouch: keys.has('z'),
  });

  const tick = (now: number): void => {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const elapsed = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    frame++;

    if (!world) {
      build();
      spawn();
    } else if (frame % SCENE_CHECK_FRAMES === 0 && now - builtAt > MIN_REBUILD_MS && sceneSignature(scene) !== signature) {
      // Geometry was added or removed (a model streamed in or was unloaded): re-index, keep standing where we are.
      build();
      spawn();
    }
    if (!session || !world) return;
    // A right-button flight owns the camera (#4868): stand down, and set the
    // walker down wherever the flight ends (the external-move check below).
    if (flySpeedStore.get().active) return;

    const eye = camera.getPosition();
    if (lastEye && Math.hypot(eye.x - lastEye.x, eye.y - lastEye.y, eye.z - lastEye.z) > EXTERNAL_MOVE) {
      spawn();
    }

    const current = input();
    const moving = current.forward !== 0 || current.right !== 0 || current.jump || current.crouch;
    if (!moving && session.isSettled() && lastEye) return;
    apply(session.frame(elapsed, current, look()));
    prefetchAround(world, session.character, PREFETCH_MS);
    walkStatusStore.set({ crouching: session.character.crouching });
  };

  const clearKeys = (): void => keys.clear();
  window.addEventListener('blur', clearKeys);
  // Read-only evidence for browser E2E, beside the viewport's `__ifc_lite_*` hooks.
  const host = globalThis as Record<string, unknown>;
  host.__ifc_lite_walk__ = () => {
    const c = session?.character;
    return {
      eye: camera.getPosition(),
      feet: c ? { x: c.feetX, y: c.feetY, z: c.feetZ } : null,
      grounded: c?.grounded ?? false,
      physics: session?.physics ?? true,
      world: world ? { ...world.stats, bounds: world.bounds } : null,
      spawn: lastSpawn,
    };
  };
  walkStatusStore.set({ active: true, physics: true, crouching: false });
  raf = requestAnimationFrame(tick);

  return {
    setKey(key, down) {
      if (down) keys.add(key); else keys.delete(key);
    },
    queueJump() {
      session?.queueJump();
    },
    togglePhysics() {
      if (!session) return;
      session.physics = !session.physics;
      // Re-landing from a float puts the walker on whatever is below.
      if (session.physics) spawn();
      walkStatusStore.set({ physics: session.physics });
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('blur', clearKeys);
      delete host.__ifc_lite_walk__;
      keys.clear();
      world = null;
      session = null;
      walkStatusStore.set({ active: false, crouching: false });
    },
  };
}
