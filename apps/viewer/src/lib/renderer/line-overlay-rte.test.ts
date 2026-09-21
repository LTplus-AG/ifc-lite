/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorWorldLineVertices, MAX_ANCHORED_LINE_EXTENT_METRES, rendererLineVertexData } from './line-overlay-rte.js';

describe('anchored line overlay bounds (#5049)', () => {
  it('partitions a 9km line at a 5,000km source offset instead of dropping or narrowing it', () => {
    const payload = anchorWorldLineVertices([5_000_000.125, 0, 0, 5_009_000.125, 0, 0]);
    assert.ok(Array.isArray(payload));
    if (!Array.isArray(payload)) return;
    assert.equal(payload.length, 2);
    for (const partition of payload) {
      assert.ok(partition.localVertices.every((coordinate) => Math.abs(coordinate) <= MAX_ANCHORED_LINE_EXTENT_METRES));
    }
    assert.equal(payload[0].origin[0], 5_000_000.125);
    assert.equal(payload[1].origin[0], 5_004_500.125);
    assert.equal(rendererLineVertexData(payload).length, 12);
    assert.equal(MAX_ANCHORED_LINE_EXTENT_METRES, 8_192);
  });
});
