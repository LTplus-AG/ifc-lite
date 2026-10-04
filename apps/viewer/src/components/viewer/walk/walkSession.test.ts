/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Walk physics end to end on small built scenes: spawn, gravity, walls,
 * stairs, doors, hidden elements, non-resident geometry, georeferenced
 * origins and a triangle budget small enough to force eviction mid-walk.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestScene } from '@/test/walk-scene-fixture.js';
import { WalkCollisionWorld } from './walkCollisionWorld.js';
import { TriangleList } from './walkTriangles.js';
import { prefetchAround } from './walkPrefetch.js';
import { NO_INPUT, WalkSession, WALK_TICK, type Vec3, type WalkInput } from './walkSession.js';
import { WALK_RADIUS, WALK_STAND_EYE } from './walkCharacter.js';

const FORWARD_Z: Vec3 = { x: 0, y: 0, z: 1 };

function run(session: WalkSession, seconds: number, input: WalkInput = NO_INPUT, look: Vec3 = FORWARD_Z): Vec3 {
  let eye: Vec3 = { x: 0, y: 0, z: 0 };
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) eye = session.frame(1 / 60, input, look);
  return eye;
}

const walk = (forward = 1, right = 0): WalkInput => ({ ...NO_INPUT, forward, right });

/** A 20 x 20 m room: 0.3 m floor slab with its top at y = 0, four 3 m walls. */
function room(scene: TestScene): void {
  scene.box([-10, -0.3, -10], [10, 0, 10], 'IfcSlab');
  scene.box([-10, 0, 9.8], [10, 3, 10]);
  scene.box([-10, 0, -10], [10, 3, -9.8]);
  scene.box([9.8, 0, -10], [10, 3, 10]);
  scene.box([-10, 0, -10], [-9.8, 3, 10]);
}

describe('WalkSession', () => {
  it('spawns on the floor below an eye inside the model and stands at eye height', () => {
    const scene = new TestScene();
    room(scene);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    assert.equal(session.spawn({ x: 0, y: 2.5, z: 0 }, FORWARD_Z), 'floor-below');
    const eye = run(session, 1);
    assert.ok(Math.abs(eye.y - WALK_STAND_EYE) < 0.02, `eye ${eye.y}`);
    assert.ok(session.character.grounded);
    assert.ok(session.isSettled());
  });

  it('lands where an aerial view is aimed, in front of the wall it hits', () => {
    const scene = new TestScene();
    scene.box([-50, -0.3, -50], [50, 0, 50], 'IfcSite');
    scene.box([-5, 0, 5], [5, 6, 5.3]);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    // From far outside and above, looking at the wall's face.
    const eye = { x: 0, y: 20, z: -40 };
    const look = { x: 0, y: 3 - 20, z: 5 + 40 };
    assert.equal(session.spawn(eye, look), 'view-target');
    const c = session.character;
    assert.ok(c.feetZ < 5 && c.feetZ > 3.5, `feet z ${c.feetZ}`);
    assert.ok(Math.abs(c.feetY) < 0.05, `feet y ${c.feetY}`);
  });

  it('aimed at a roof from outside, enters the top storey under it instead of standing on it', () => {
    const scene = new TestScene();
    scene.box([-50, -0.3, -50], [50, 0, 50], 'IfcSite');
    // Two storeys, 3 m each, 0.3 m slabs, a flat roof on top.
    scene.box([-5, 2.7, -5], [5, 3, 5], 'IfcSlab');
    scene.box([-5, 5.7, -5], [5, 6, 5], 'IfcRoof');
    const session = new WalkSession(new WalkCollisionWorld(scene));
    assert.equal(session.spawn({ x: 0, y: 40, z: -30 }, { x: 0, y: -40, z: 30 }), 'view-target');
    assert.ok(Math.abs(session.character.feetY - 3) < 0.05, `upper floor, not the roof (feet ${session.character.feetY})`);
  });

  it('aimed into an empty courtyard, lands on the nearest floor along the line of sight', () => {
    const scene = new TestScene();
    // An L: one wing along x, one along z, nothing at the inner corner, no site.
    scene.box([0, -0.3, 0], [30, 0, 8], 'IfcSlab');
    scene.box([0, 2.7, 0], [30, 3, 8], 'IfcRoof');
    scene.box([0, -0.3, 8], [8, 0, 30], 'IfcSlab');
    scene.box([0, 2.7, 8], [8, 3, 30], 'IfcRoof');
    const session = new WalkSession(new WalkCollisionWorld(scene));
    // From high above the empty quadrant, looking down into it: the view ray hits nothing.
    const eye = { x: 60, y: 60, z: 60 };
    assert.equal(session.spawn(eye, { x: 20 - 60, y: 0 - 60, z: 20 - 60 }), 'view-target');
    const c = session.character;
    assert.ok(Math.abs(c.feetY) < 0.05, `inside on the ground floor (feet ${c.feetY})`);
    assert.ok(c.feetX <= 8 || c.feetZ <= 8, `on a wing (${c.feetX}, ${c.feetZ})`);
  });

  it('aimed along a line that crosses no building, lands on the floor nearest the aim point', () => {
    const scene = new TestScene();
    // Two separate pavilions in opposite corners of the model box, roofed.
    scene.box([0, -0.3, 0], [5, 0, 5], 'IfcSlab');
    scene.box([0, 2.7, 0], [5, 3, 5], 'IfcRoof');
    scene.box([25, -0.3, 25], [30, 0, 30], 'IfcSlab');
    scene.box([25, 2.7, 25], [30, 3, 30], 'IfcRoof');
    const session = new WalkSession(new WalkCollisionWorld(scene));
    // The view's ground track runs along z = 15, between the two.
    assert.equal(session.spawn({ x: 60, y: 40, z: 15 }, { x: 26 - 60, y: 0 - 40, z: 15 - 15 }), 'view-target');
    const c = session.character;
    assert.ok(Math.abs(c.feetY) < 0.05, `under a roof (feet ${c.feetY})`);
    assert.ok(c.feetX >= 25 && c.feetZ >= 25, `the pavilion nearest the aim point (${c.feetX}, ${c.feetZ})`);
  });

  it('prefers an enclosed room over a sheltered ledge outside the facade (BWK)', () => {
    const scene = new TestScene();
    // A walled room with a roof, and outside its +x wall a balcony ledge under a canopy.
    scene.box([0, -0.3, 0], [10, 0, 10], 'IfcSlab');
    scene.box([0, 6, 0], [10, 6.3, 10], 'IfcRoof');
    scene.box([0, 0, 0], [0.2, 6, 10]);
    scene.box([9.8, 0, 0], [10, 6, 10]);
    scene.box([0, 0, 0], [10, 6, 0.2]);
    scene.box([0, 0, 9.8], [10, 6, 10]);
    scene.box([10.5, 2.7, 0], [12, 3, 10], 'IfcSlab');
    scene.box([10.5, 5.7, 0], [12, 6, 10], 'IfcSlab');
    const session = new WalkSession(new WalkCollisionWorld(scene));
    // The line of sight's ground track runs straight over the ledge; the ray itself passes under everything.
    assert.equal(session.spawn({ x: 11.2, y: 40, z: 60 }, { x: 0, y: -40, z: -40 }), 'view-target');
    const c = session.character;
    assert.ok(c.feetX > 0.2 && c.feetX < 9.8, `inside the room, not on the ledge (x ${c.feetX})`);
    assert.ok(Math.abs(c.feetY) < 0.05, `on the room floor (feet ${c.feetY})`);
  });

  it('falls under gravity and stops on a floor', () => {
    const scene = new TestScene();
    room(scene);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 2.5, z: 0 }, FORWARD_Z);
    session.character.teleport(0, 2, 0);
    run(session, 2);
    assert.ok(Math.abs(session.character.feetY) < 0.02, `feet ${session.character.feetY}`);
  });

  it('is stopped by a wall a capsule radius short of it', () => {
    const scene = new TestScene();
    room(scene);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 2.5, z: 0 }, FORWARD_Z);
    run(session, 8, walk());
    const z = session.character.feetZ;
    assert.ok(z < 9.8 - WALK_RADIUS + 0.01 && z > 9.8 - WALK_RADIUS - 0.05, `stopped at ${z}`);
  });

  it('slides along a wall when walking into it at an angle', () => {
    const scene = new TestScene();
    room(scene);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 2.5, z: 8 }, FORWARD_Z);
    const start = session.character.feetX;
    run(session, 1, walk(1, 1));
    // Screen-right while looking +Z in a right-handed Y-up frame is -X.
    assert.ok(start - session.character.feetX > 0.8, 'kept moving along the wall');
  });

  it('climbs a flight of 180 mm risers and walks back down it', () => {
    const scene = new TestScene();
    scene.box([-10, -0.3, -10], [10, 0, 30], 'IfcSlab');
    scene.stairs(-1, 0, 0, 2, 10, 0.18, 0.28);
    // Landing at the top.
    scene.box([-1, 0, 2.8], [1, 1.8, 12], 'IfcSlab');
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 1.6, z: -2 }, FORWARD_Z);
    run(session, 4, walk());
    assert.ok(Math.abs(session.character.feetY - 1.8) < 0.03, `top at ${session.character.feetY}`);
    run(session, 6, walk(-1));
    assert.ok(Math.abs(session.character.feetY) < 0.03, `bottom at ${session.character.feetY}`);
    assert.ok(session.character.feetZ < -1, 'walked off the bottom step');
  });

  it('does not climb a 600 mm ledge, but can jump onto it', () => {
    const scene = new TestScene();
    scene.box([-10, -0.3, -10], [10, 0, 10], 'IfcSlab');
    scene.box([-10, 0, 2], [10, 0.6, 10], 'IfcSlab');
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 1.6, z: 0 }, FORWARD_Z);
    run(session, 2, walk());
    assert.ok(session.character.feetY < 0.05, 'blocked by the ledge');
    session.queueJump();
    run(session, 1.5, walk());
    assert.ok(Math.abs(session.character.feetY - 0.6) < 0.03, `on the ledge at ${session.character.feetY}`);
  });

  it('walks up a 30° ramp but not a 60° one', () => {
    for (const [degrees, climbs] of [[30, true], [60, false]] as const) {
      const scene = new TestScene();
      scene.box([-10, -0.3, -10], [10, 0, 30], 'IfcSlab');
      // A ramp surface rising along +Z from z = 1 to a 2 m top.
      const going = 2 / Math.tan((degrees * Math.PI) / 180);
      scene.quad([[-1, 0, 1], [1, 0, 1], [1, 2, 1 + going], [-1, 2, 1 + going]], 'IfcRamp');
      const session = new WalkSession(new WalkCollisionWorld(scene));
      session.spawn({ x: 0, y: 1.6, z: -1 }, FORWARD_Z);
      let highest = 0;
      for (let i = 0; i < 180; i++) {
        session.frame(1 / 60, walk(), FORWARD_Z);
        highest = Math.max(highest, session.character.feetY);
      }
      assert.equal(highest > 1.5, climbs, `${degrees}° ramp: highest feet ${highest}`);
    }
  });

  it('walks through doors and spaces but not through windows', () => {
    const scene = new TestScene();
    scene.box([-10, -0.3, -10], [10, 0, 10], 'IfcSlab');
    scene.box([-1, 0, 2], [1, 2.1, 2.1], 'IfcDoor');
    scene.box([-10, 0, -10], [10, 3, 10], 'IfcSpace');
    scene.box([-1, 0, 5], [1, 2.1, 5.1], 'IfcWindow');
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 1.6, z: 0 }, FORWARD_Z);
    run(session, 4, walk());
    const z = session.character.feetZ;
    assert.ok(z > 2.1 && z < 5, `through the door, stopped at the window (${z})`);
  });

  it('walks through hidden elements and collides again once they are shown', () => {
    const scene = new TestScene();
    scene.box([-10, -0.3, -10], [10, 0, 10], 'IfcSlab');
    const wall = scene.box([-10, 0, 2], [10, 3, 2.2]);
    const hidden = new Set([wall]);
    const session = new WalkSession(new WalkCollisionWorld(scene, { collidable: (id) => !hidden.has(id) }));
    session.spawn({ x: 0, y: 1.6, z: 0 }, FORWARD_Z);
    run(session, 1.5, walk());
    assert.ok(session.character.feetZ > 2.2, 'passed the hidden wall');
    hidden.clear();
    run(session, 1.5, walk(-1));
    assert.ok(session.character.feetZ > 2.2, 'blocked once shown');
  });

  it('treats geometry that is not resident as absent, and collides once it is', () => {
    const scene = new TestScene();
    scene.box([-10, -0.3, -10], [10, 0, 10], 'IfcSlab');
    const wall = scene.box([-10, 0, 2], [10, 3, 2.2]);
    scene.nonResident.add(wall);
    const world = new WalkCollisionWorld(scene);
    const session = new WalkSession(world);
    session.spawn({ x: 0, y: 1.6, z: 0 }, FORWARD_Z);
    run(session, 1.5, walk());
    assert.ok(session.character.feetZ > 2.2);
    assert.ok(world.stats.missing > 0, 'the miss is reported');
    scene.nonResident.clear();
    run(session, 1.5, walk(-1));
    assert.ok(session.character.feetZ > 2.2, 'restored geometry collides (the miss was not cached)');
  });

  it('collides with a large tessellated floor at georeferenced coordinates', () => {
    const scene = new TestScene();
    const origin: [number, number, number] = [2_600_000, 400, 1_200_000];
    // 80 x 80 quads = 12 800 triangles: indexed by a triangle tree, not scanned.
    scene.grid(origin[0] - 40, origin[2] - 40, 80, origin[1], 80, 'IfcSlab', origin);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: origin[0], y: origin[1] + 3, z: origin[2] }, FORWARD_Z);
    run(session, 3, walk());
    assert.ok(Math.abs(session.character.feetY - origin[1]) < 0.03, `feet ${session.character.feetY}`);
    assert.ok(session.character.feetZ - origin[2] > 5, 'walked across it');
  });

  it('keeps colliding correctly while a tiny triangle budget evicts entities mid-walk', () => {
    const scene = new TestScene();
    for (let i = 0; i < 40; i++) scene.grid(-10, i * 2, 20, 0, 4, 'IfcSlab');
    const world = new WalkCollisionWorld(scene, { triangleBudget: 200 });
    const session = new WalkSession(world);
    session.spawn({ x: 0, y: 1.6, z: 1 }, FORWARD_Z);
    run(session, 20, walk());
    assert.ok(world.stats.evicted > 0, 'the budget forced evictions');
    assert.ok(Math.abs(session.character.feetY) < 0.03, `never fell through (feet ${session.character.feetY})`);
    assert.ok(session.character.feetZ > 40, 'walked the whole strip');
  });

  it('a queued jump un-settles a resting walker, so a tapped key is never lost', () => {
    const scene = new TestScene();
    room(scene);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 2.5, z: 0 }, FORWARD_Z);
    run(session, 1);
    assert.ok(session.isSettled());
    session.queueJump();
    assert.ok(!session.isSettled());
    run(session, 0.2);
    assert.ok(session.character.feetY > 0.5, `in the air (feet ${session.character.feetY})`);
  });

  it('keeps entity boxes conservative under float32 rounding at georeferenced coordinates', () => {
    const scene = new TestScene();
    // At 2.6e6 m float32 steps by 0.25 m: 2600005.13 rounds UP to 2600005.25.
    // Vertices local to an origin (as georeferenced meshes are): exact; only the world box rounds.
    scene.box([2_600_005.13, 0, -1], [2_600_005.2, 3, 1], 'IfcWall', [2_600_000, 0, 0]);
    const world = new WalkCollisionWorld(scene);
    const tris = new TriangleList();
    world.gather(2_600_004.8, 0.5, -0.5, 2_600_005.14, 1.5, 0.5, tris);
    assert.ok(tris.length > 0, 'a query reaching just past the true face must find the wall');
  });

  it('spawning under a low soffit moves to the nearest spot where a standing capsule fits', () => {
    const scene = new TestScene();
    room(scene);
    // A downstand beam across the room, 1.5 m above the floor, right over the eye.
    scene.box([-0.2, 1.5, -10], [0.2, 3, 10], 'IfcBeam');
    const session = new WalkSession(new WalkCollisionWorld(scene));
    assert.equal(session.spawn({ x: 0, y: 1.2, z: 0 }, FORWARD_Z), 'floor-below');
    const c = session.character;
    assert.ok(Math.abs(c.feetY) < 0.05, `same floor (feet ${c.feetY})`);
    assert.ok(!c.overlaps(c.feetX, c.feetY, c.feetZ, 1.75), `fits where it stands (${c.feetX}, ${c.feetZ})`);
  });

  it('turning collision off while crouched stands the eye back up without further input', () => {
    const scene = new TestScene();
    room(scene);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 2.5, z: 0 }, FORWARD_Z);
    run(session, 1, { ...NO_INPUT, crouch: true });
    assert.ok(session.character.crouching);
    session.physics = false;
    assert.ok(!session.isSettled(), 'the eye still has to rise');
    const eye = run(session, 1);
    assert.ok(Math.abs(eye.y - session.character.feetY - WALK_STAND_EYE) < 0.01, `stood up (eye ${eye.y})`);
    assert.ok(session.isSettled());
  });

  it('passes through a door whose pieces carry no ifcType (instanced) when the entity type says IfcDoor', () => {
    const scene = new TestScene();
    scene.box([-10, -0.3, -10], [10, 0, 10], 'IfcSlab');
    const door = scene.box([-10, 0, 2], [10, 2.1, 2.1], 'IfcDoor');
    // Instanced occurrences and colour-merged extracts arrive without ifcType.
    const pieces = (id: number) => scene.pieces(id)?.map((p) => (id === door ? { ...p, ifcType: undefined } : p));
    const types = (id: number) => (id === door ? 'IfcDoor' : undefined);
    const solid = new WalkSession(new WalkCollisionWorld({ entityIds: () => scene.entityIds(), bounds: (id) => scene.bounds(id), pieces }));
    const open = new WalkSession(new WalkCollisionWorld({ entityIds: () => scene.entityIds(), bounds: (id) => scene.bounds(id), pieces, entityType: types }));
    for (const s of [solid, open]) { s.spawn({ x: 0, y: 1.6, z: 0 }, FORWARD_Z); run(s, 3, walk()); }
    assert.ok(solid.character.feetZ < 2, 'without the entity type the untyped door blocks (the defect)');
    assert.ok(open.character.feetZ > 2.1, `with it, the walker passes (z ${open.character.feetZ})`);
  });

  it('does not thrash the prepared ring when one entity alone is over the triangle budget', () => {
    const scene = new TestScene();
    scene.grid(-20, -20, 40, 0, 40, 'IfcSlab'); // 3 200 triangles
    for (let i = 0; i < 20; i++) scene.box([-5 + i * 0.5, 0, 3], [-4.8 + i * 0.5, 1, 3.2], 'IfcFurnishingElement');
    const world = new WalkCollisionWorld(scene, { triangleBudget: 3000 });
    const session = new WalkSession(world);
    session.spawn({ x: 0, y: 1.6, z: 0 }, FORWARD_Z);
    for (let i = 0; i < 120; i++) {
      session.frame(1 / 60, NO_INPUT, FORWARD_Z);
      prefetchAround(world, session.character, 2);
    }
    assert.ok(world.stats.prepared < 60, `prepared ${world.stats.prepared} times: the ring was rebuilt over and over`);
  });

  it('a view straight down into an empty courtyard spawns without NaN probes', () => {
    const scene = new TestScene();
    scene.box([0, -0.3, 0], [30, 0, 8], 'IfcSlab');
    scene.box([0, 2.7, 0], [30, 3, 8], 'IfcRoof');
    scene.box([0, -0.3, 8], [8, 0, 30], 'IfcSlab');
    scene.box([0, 2.7, 8], [8, 3, 30], 'IfcRoof');
    const world = new WalkCollisionWorld(scene);
    // A NaN probe matches every box in the tree, so it would index the whole model.
    let nanRays = 0;
    const raycast = world.raycast.bind(world);
    world.raycast = (...args: Parameters<WalkCollisionWorld['raycast']>) => {
      if (args.some(Number.isNaN)) nanRays++;
      return raycast(...args);
    };
    const session = new WalkSession(world);
    assert.equal(session.spawn({ x: 20, y: 50, z: 20 }, { x: 0, y: -1, z: 0 }), 'view-target');
    const c = session.character;
    assert.equal(nanRays, 0, 'no NaN probes');
    assert.ok(Number.isFinite(c.feetX) && Number.isFinite(c.feetY) && Number.isFinite(c.feetZ), `finite (${c.feetX}, ${c.feetY}, ${c.feetZ})`);
  });

  it('floats through walls with physics off', () => {
    const scene = new TestScene();
    room(scene);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 2.5, z: 0 }, FORWARD_Z);
    session.physics = false;
    run(session, 6, walk());
    assert.ok(session.character.feetZ > 10, 'passed the wall');
  });

  it('interpolates between ticks: the eye never jumps a whole tick on a fast frame rate', () => {
    const scene = new TestScene();
    room(scene);
    const session = new WalkSession(new WalkCollisionWorld(scene));
    session.spawn({ x: 0, y: 2.5, z: -5 }, FORWARD_Z);
    run(session, 1, walk());
    let last = session.frame(1 / 240, walk(), FORWARD_Z).z;
    for (let i = 0; i < 240; i++) {
      const z = session.frame(1 / 240, walk(), FORWARD_Z).z;
      assert.ok(z - last <= 2.5 * WALK_TICK + 1e-6, 'at most one tick of travel per 240 Hz frame');
      last = z;
    }
  });
});
