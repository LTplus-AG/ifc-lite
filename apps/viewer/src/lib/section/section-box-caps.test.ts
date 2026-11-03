/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sectionBoxCapPlanes, cuttingSectionBoxCapPlanes } from './section-box-caps.js';
import { capCutConfig, capSignature } from './section-cut-config.js';
import { moveSectionBoxFace } from './section-box.js';
import type { SectionPlane } from '@/store/types';

const BOX = { min: [0, -1, 2] as [number, number, number], max: [10, 3, 8] as [number, number, number] };
const BOUNDS = { min: { x: -5, y: -5, z: -5 }, max: { x: 20, y: 20, z: 20 } };

const plane = (over: Partial<SectionPlane> = {}): SectionPlane => ({
  id: 'p', name: 'A', showGizmo: true, axis: 'down', position: 40, enabled: true, flipped: false, showCap: true, showOutlines: true,
  capStyle: { fillColor: [1, 1, 1, 1], strokeColor: [0, 0, 0, 1], pattern: 'solid', spacingPx: 8, angleRad: 0, widthPx: 1, secondaryAngleRad: 0 },
  ...over,
});

describe('section box face caps (#8696)', () => {
  it('each face is a plane on the face, its normal out of the box, keyed by the renderer\'s cap key', () => {
    const planes = sectionBoxCapPlanes(BOX);
    assert.deepEqual(planes.map((p) => p.id), ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'].map((f) => `section-box:${f}`));
    const maxX = planes[1].custom!;
    assert.deepEqual(maxX.normal, [1, 0, 0]);
    assert.equal(maxX.distance, 10);
    const minY = planes[2].custom!;
    assert.deepEqual(minY.normal, [0, -1, 0]);
    assert.equal(minY.distance, 1, 'dot(point on y = -1, (0,-1,0))');
    for (const p of planes) {
      const c = p.custom!;
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      assert.equal(dot(c.pickedAt, c.normal), c.distance, 'the basis origin is on the face');
      assert.equal(dot(c.tangent, c.normal), 0);
      assert.equal(dot(c.bitangent, c.normal), 0);
    }
  });

  it('cuts through the cap config on the face plane', () => {
    const config = capCutConfig(sectionBoxCapPlanes(BOX)[4], BOUNDS)!;
    assert.deepEqual(config.plane.customPlane?.normal, { x: 0, y: 0, z: -1 });
    assert.equal(config.plane.customPlane?.distance, -2);
  });

  it('moving one face changes only that face\'s signature, so a drag re-cuts one face', () => {
    const before = sectionBoxCapPlanes(BOX).map(capSignature);
    const after = sectionBoxCapPlanes(moveSectionBoxFace(BOX, 'maxY', 2)).map(capSignature);
    assert.deepEqual(after.map((sig, i) => sig !== before[i]), [false, false, false, true, false, false]);
  });

  it('caps the box that clips, only while it cuts', () => {
    assert.equal(cuttingSectionBoxCapPlanes(plane({ box: BOX }), []).length, 6);
    assert.equal(cuttingSectionBoxCapPlanes(plane({ box: BOX, enabled: false }), []).length, 0);
    assert.equal(cuttingSectionBoxCapPlanes(plane(), []).length, 0);
    const inactiveBox = plane({ id: 'b', box: BOX });
    assert.equal(cuttingSectionBoxCapPlanes(plane(), [inactiveBox]).length, 6, 'an inactive cutting box still clips, so it still caps');
  });
});
