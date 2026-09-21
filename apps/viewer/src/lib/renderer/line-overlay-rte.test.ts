/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorWorldLineVertices, MAX_ANCHORED_LINE_EXTENT_METRES, rendererLineVertexData } from './line-overlay-rte.js';

describe('anchored line overlay bounds (#5049)', () => {
  it('refuses an unpartitioned 9km channel rather than narrowing it into f32', () => {
    const previous = console.warn;
    console.warn = () => {};
    try {
      const payload = anchorWorldLineVertices([5_000_000.125, 0, 0, 5_009_000.125, 0, 0]);
      assert.equal(rendererLineVertexData(payload).length, 0);
    } finally {
      console.warn = previous;
    }
    assert.equal(MAX_ANCHORED_LINE_EXTENT_METRES, 8_192);
  });
});
