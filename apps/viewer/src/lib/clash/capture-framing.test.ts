/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { frameSelectionBounds } from './capture-framing.js';

describe('capture framing (#4921)', () => {
  it('requests a canvas render after applying a synchronous camera frame', async () => {
    let pose = 'old';
    let renderRequestedAtPose: string | null = null;
    let scaleCalculatedAtPose: string | null = null;
    const frameReady = frameSelectionBounds(
      {
        frameBounds: async () => { pose = 'framed'; },
      },
      {
        requestRender: () => { renderRequestedAtPose = pose; },
      },
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      0,
      () => { scaleCalculatedAtPose = pose; },
    );

    assert.equal(pose, 'framed', 'duration-0 framing must apply before invalidating the canvas');
    assert.equal(renderRequestedAtPose, 'framed',
      'the paint wait must contain a frame rendered from the captured camera pose');
    assert.equal(await frameReady, true);
    assert.equal(scaleCalculatedAtPose, 'framed',
      'pose-dependent scale UI must update after framing completes');
  });

  it('reports malformed renderer bounds as unframed instead of reusing the previous pose', async () => {
    let frameCalls = 0;
    let renderCalls = 0;
    let scaleCalls = 0;
    const framed = await frameSelectionBounds(
      { frameBounds: async () => { frameCalls++; } },
      { requestRender: () => { renderCalls++; } },
      { x: Number.POSITIVE_INFINITY, y: 10, z: 10 },
      { x: Number.NEGATIVE_INFINITY, y: 0, z: 0 },
      0,
      () => { scaleCalls++; },
    );

    assert.equal(framed, false);
    assert.equal(frameCalls, 0, 'do not delegate a box the renderer will reject as a resolved no-op');
    assert.equal(renderCalls, 0);
    assert.equal(scaleCalls, 0);
  });
});
