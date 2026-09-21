/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorWorldLineVertices } from './line-overlay-rte.js';

describe('anchorWorldLineVertices', () => {
  it('keeps a national-grid centimetre residual local for every viewer producer (#5049)', () => {
    const lines = anchorWorldLineVertices([
      5_000_000.015625, 20, -4,
      5_000_000.025625, 20, -4,
    ]);

    assert.ok(!(lines instanceof Float32Array));
    if (lines instanceof Float32Array) return;
    assert.equal(lines.origin[0], 5_000_000.015625);
    assert.ok(Math.abs(lines.localVertices[3] - 0.01) < 1e-8);
  });
});
