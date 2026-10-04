/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewport glue: camera moves made by someone else (a tween, inertia, a
 * zoom) set the walker down once they stop, never once per frame; float mode
 * follows the camera instead of dropping to a floor; dispose stops writing.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { TestScene } from '@/test/walk-scene-fixture.js';
import { createWalkController, type WalkController } from './walkController.js';

interface Vec3 { x: number; y: number; z: number }

function rig() {
  const scene = new TestScene();
  scene.box([-20, -0.3, -20], [20, 0, 20], 'IfcSlab');
  scene.box([-20, 4, -20], [20, 4.3, 20], 'IfcSlab');
  const pose = { position: { x: 0, y: 1.6, z: 0 } as Vec3, target: { x: 0, y: 1.6, z: 5 } as Vec3 };
  const writes = { count: 0 };
  const camera = {
    getPosition: () => ({ ...pose.position }),
    getTarget: () => ({ ...pose.target }),
    setPosition: (x: number, y: number, z: number) => { pose.position = { x, y, z }; writes.count++; },
    setTarget: (x: number, y: number, z: number) => { pose.target = { x, y, z }; },
    stopInertia: () => {},
  };
  const sceneContents = {
    getAllMeshDataExpressIds: () => [...scene.entityIds()],
    getEntityBoundingBox: (id: number) => scene.bounds(id),
    getMeshDataPieces: (id: number) => scene.pieces(id),
    isInstancedEntity: () => false,
    getInstancedEntityBounds: () => null,
    getInstancedMeshDataPieces: () => undefined,
    getBatchedMeshes: () => [],
    getMeshes: () => [],
    getInstancedEntityCount: () => 0,
  };
  const renderer = { getCamera: () => camera, getScene: () => sceneContents, requestRender: () => {} } as unknown as Renderer;
  return { pose, writes, renderer };
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const frames = async (n: number) => { for (let i = 0; i < n; i++) await frame(); };
const hook = () => (globalThis as { __ifc_lite_walk__?: () => { feet: Vec3 | null; spawn: { outcome: string } | null } }).__ifc_lite_walk__?.();

describe('createWalkController', () => {
  let controller: WalkController | null = null;
  afterEach(() => { controller?.dispose(); controller = null; });

  it('waits out a camera tween, then sets the walker down once where it ended', async () => {
    const { pose, writes, renderer } = rig();
    controller = createWalkController(renderer, () => true, () => 0);
    await frames(5);
    assert.ok(Math.abs(hook()!.feet!.y) < 0.05, 'standing on the ground floor');
    const before = writes.count;
    for (let i = 1; i <= 10; i++) {
      // A tween moving the camera every frame, up to the next storey.
      pose.position = { x: i, y: 1.6 + i * 0.4, z: 0 };
      pose.target = { x: i, y: 1.6 + i * 0.4, z: 5 };
      await frame();
    }
    assert.equal(writes.count, before, 'no spawn while the camera is still moving');
    await frames(4);
    assert.ok(writes.count > before, 'set down once the tween ended');
    const feet = hook()!.feet!;
    assert.ok(Math.abs(feet.x - 10) < 0.05 && Math.abs(feet.y - 4.3) < 0.05, `on the upper floor under the tween's end (${feet.x}, ${feet.y})`);
  });

  it('floating, follows a camera move instead of dropping to the floor below', async () => {
    const { pose, renderer } = rig();
    controller = createWalkController(renderer, () => true, () => 0);
    await frames(5);
    controller.togglePhysics();
    pose.position = { x: 3, y: 10, z: 3 };
    pose.target = { x: 3, y: 10, z: 8 };
    await frames(5);
    assert.equal(hook()!.spawn!.outcome, 'float');
    assert.ok(Math.abs(pose.position.y - 10) < 1e-6, `the camera stays where it was moved (${pose.position.y})`);
  });

  it('stops writing to the camera and removes its hook on dispose', async () => {
    const { writes, renderer } = rig();
    controller = createWalkController(renderer, () => true, () => 0);
    await frames(5);
    controller.setKey('w', true);
    controller.dispose();
    controller = null;
    const after = writes.count;
    await frames(5);
    assert.equal(writes.count, after);
    assert.equal(hook(), undefined);
  });
});
