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

  it('groups hundreds of compact segments under one anchor (#5049)', () => {
    const vertices: number[] = [];
    for (let index = 0; index < 400; index++) {
      vertices.push(5_000_000 + index, 20, 3, 5_000_000 + index + 0.5, 20.25, 3);
    }
    const payload = anchorWorldLineVertices(vertices);
    assert.ok(!Array.isArray(payload));
    assert.ok('localVertices' in payload);
    if (Array.isArray(payload) || !('localVertices' in payload)) return;
    assert.equal(payload.localVertices.length, vertices.length);
    assert.deepEqual(payload.origin, [5_000_000, 20, 3]);
  });

  it('keeps genuinely separated segments in independent precision partitions (#5049)', () => {
    const vertices: number[] = [];
    for (let index = 0; index < 40; index++) {
      const x = index * (MAX_ANCHORED_LINE_EXTENT_METRES * 3);
      vertices.push(x, 0, 0, x + 1, 0, 0);
    }
    const payload = anchorWorldLineVertices(vertices);
    assert.ok(Array.isArray(payload));
    if (!Array.isArray(payload)) return;
    assert.equal(payload.length, 40);
    assert.ok(payload.every((partition) => partition.localVertices.every(Number.isFinite)));
  });

  it('rejects non-finite world values before creating a GPU payload (#5049)', () => {
    assert.throws(() => anchorWorldLineVertices([0, 0, 0, Number.NaN, 0, 0]), /finite/);
  });
});
