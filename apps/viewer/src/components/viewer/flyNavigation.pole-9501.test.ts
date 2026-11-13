/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fly look, fly strafe and the Walk tool's drag look from a top or bottom
 * preset (#9501). The presets look exactly along the vertical and keep the
 * screen orientation in a horizontal `up`, so the look direction has no
 * heading of its own. Taking the heading from the bare look direction turned
 * the first look toward +Z whatever the screen showed, and kept the plan's
 * horizontal `up` on a level view: 90-180 degrees of roll.
 *
 * Every pose here comes from the real `Camera.setPresetView`, and screen
 * directions are read by projecting through the real camera.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@ifc-lite/renderer';
import { applyDragNavigation } from './dragNavigation.js';
import { flyDirection, flyLook, type Vec3 } from './flyNavigation.js';

const W = 800;
const H = 600;
const BOUNDS = { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 3, z: 5 } };

/** A camera after `clicks` clicks on a preset, tween run to the end. */
function preset(view: 'top' | 'bottom', clicks: number, buildingRotation = 0): Camera {
  const camera = new Camera();
  camera.setAspect(W / H);
  const realNow = Date.now;
  const hadRaf = 'requestAnimationFrame' in globalThis;
  const realRaf = Reflect.get(globalThis, 'requestAnimationFrame');
  let now = 1_000;
  Date.now = () => now;
  Reflect.set(globalThis, 'requestAnimationFrame', () => 0);
  try {
    for (let i = 0; i < clicks; i++) {
      camera.setPresetView(view, BOUNDS, buildingRotation);
      now += 1_000;
      camera.update(0);
    }
  } finally {
    Date.now = realNow;
    if (hadRaf) Reflect.set(globalThis, 'requestAnimationFrame', realRaf);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
  const look = sub(camera.getTarget(), camera.getPosition());
  assert.ok(Math.hypot(look.x, look.z) < 1e-9, 'precondition: the preset looks along the vertical');
  return camera;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** Horizontal unit direction drawn straight up the screen (from the target). */
function screenUpHeading(camera: Camera): { x: number; z: number } {
  const t = camera.getTarget();
  const o = camera.projectToScreen(t, W, H)!;
  const px = camera.projectToScreen({ x: t.x + 1, y: t.y, z: t.z }, W, H)!;
  const pz = camera.projectToScreen({ x: t.x, y: t.y, z: t.z + 1 }, W, H)!;
  // Screen "up" is -y; solve which world x/z combination points that way.
  const ex = { x: px.x - o.x, y: px.y - o.y }, ez = { x: pz.x - o.x, y: pz.y - o.y };
  const det = ex.x * ez.y - ez.x * ex.y;
  const a = (0 * ez.y - ez.x * -1) / det, b = (ex.x * -1 - 0 * ex.y) / det;
  const n = Math.hypot(a, b);
  return { x: a / n, z: b / n };
}

/** Roll of the image: angle between screen-up and world Y projected into the image (degrees). */
function roll(camera: Camera): number {
  const p = camera.getPosition();
  const f = sub(camera.getTarget(), p);
  const fl = Math.hypot(f.x, f.y, f.z);
  const probe = { x: p.x + f.x / fl * 2, y: p.y + f.y / fl * 2, z: p.z + f.z / fl * 2 };
  const a = camera.projectToScreen(probe, W, H)!;
  const b = camera.projectToScreen({ ...probe, y: probe.y + 0.1 }, W, H)!;
  return Math.abs(Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI);
}

const CASES = [
  ['top', 1, 0], ['top', 2, 0], ['top', 3, 0], ['top', 4, 0], ['top', 1, 0.3],
  ['bottom', 1, 0], ['bottom', 2, 0], ['bottom', 2, 0.3],
] as const;

describe('fly and walk look off a plan preset (#9501)', () => {
  for (const [view, clicks, rotation] of CASES) {
    const label = `${view} x${clicks}${rotation ? ` rotated ${rotation}` : ''}`;

    it(`${label}: the first look keeps the screen's top at the top, with no roll`, () => {
      const camera = preset(view, clicks, rotation);
      const before = screenUpHeading(camera);
      // Walk-tool drag: look toward the horizon (mouse up from a plan, down from a soffit).
      for (let i = 0; i < 40; i++) applyDragNavigation(camera, 'look', 0, view === 'top' ? -8 : 8);
      const look = sub(camera.getTarget(), camera.getPosition());
      const flat = Math.hypot(look.x, look.z);
      // Raising the view off a plan faces the screen's top; lowering it off a soffit faces its bottom.
      const want = view === 'top' ? before : { x: -before.x, z: -before.z };
      assert.ok((look.x * want.x + look.z * want.z) / flat > 0.999, `${label}: heading ${JSON.stringify(look)} vs ${JSON.stringify(want)}`);
      assert.ok(roll(camera) < 1e-3, `${label}: roll ${roll(camera)}`);
    });

    it(`${label}: fly look returns a world-Y up, and D strafes to the screen's right`, () => {
      const camera = preset(view, clicks, rotation);
      const pose = { position: camera.getPosition(), target: camera.getTarget(), up: camera.getUp() };
      const d = flyDirection(pose, { forward: 0, right: 1, up: 0 });
      const t = camera.getTarget();
      const o = camera.projectToScreen(t, W, H)!;
      const r = camera.projectToScreen({ x: t.x + d.x, y: t.y, z: t.z + d.z }, W, H)!;
      assert.ok(r.x - o.x > 1 && Math.abs(r.y - o.y) < 1e-3 * Math.abs(r.x - o.x), `${label}: D moved on screen by ${r.x - o.x}, ${r.y - o.y}`);
      const next = flyLook(pose, 3, 0);
      assert.ok(next);
      assert.deepEqual(next.up, { x: 0, y: 1, z: 0 });
    });
  }
});
