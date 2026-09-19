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
    );

    assert.equal(pose, 'framed', 'duration-0 framing must apply before invalidating the canvas');
    assert.equal(renderRequestedAtPose, 'framed',
      'the paint wait must contain a frame rendered from the captured camera pose');
    await frameReady;
  });
});
