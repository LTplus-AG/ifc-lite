/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Jump to peer" reproduces a peer's plan rotation (#9501). A top preset
 * looks straight down and keeps its rotation in a horizontal `up`; the jump
 * used to rebuild the view with world Y, which on a vertical look falls back
 * to a fixed orientation. The screen direction is read through the real
 * renderer camera.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@ifc-lite/renderer';
import { peerViewpoint, type PeerCamera } from './peer-viewpoint.js';

/** Screen angle (degrees) at which world +X points, through a viewpoint. */
function eastOnScreen(vp: ReturnType<typeof peerViewpoint>): number {
  const camera = new Camera();
  camera.setAspect(1);
  camera.setPosition(vp.position.x, vp.position.y, vp.position.z);
  camera.setTarget(vp.target.x, vp.target.y, vp.target.z);
  camera.setUp(vp.up.x, vp.up.y, vp.up.z);
  const o = camera.projectToScreen(vp.target, 600, 600)!;
  const e = camera.projectToScreen({ ...vp.target, x: vp.target.x + 1 }, 600, 600)!;
  return Math.round(Math.atan2(e.y - o.y, e.x - o.x) * 180 / Math.PI);
}

const PLAN: PeerCamera = { position: { x: 1, y: 30, z: 2 }, target: { x: 1, y: 0, z: 2 }, fov: 0.8 };

describe('peerViewpoint', () => {
  it('keeps a peer plan view turned the way they see it (#9501)', () => {
    // Their top preset clicked twice: screen-up is -X, so +X points down the screen.
    const theirs = { ...PLAN, up: { x: -1, y: 0, z: 0 } };
    assert.equal(eastOnScreen(peerViewpoint(theirs, 'orthographic')), 90);
    // Without `up` (an older peer) the plan comes out in the fallback orientation.
    assert.equal(eastOnScreen(peerViewpoint(PLAN, 'orthographic')), 0);
  });

  it('falls back to world Y for a missing, zero or non-finite up, and keeps our projection', () => {
    for (const up of [undefined, { x: 0, y: 0, z: 0 }, { x: NaN, y: 1, z: 0 }]) {
      const vp = peerViewpoint({ ...PLAN, up }, 'perspective');
      assert.deepEqual(vp.up, { x: 0, y: 1, z: 0 });
      assert.equal(vp.projectionMode, 'perspective');
    }
  });
});
