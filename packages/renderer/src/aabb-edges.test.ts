/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { aabbEdgeLineList } from './aabb-edges.ts';

describe('aabbEdgeLineList (#1277 clash overlap box)', () => {
  it('emits 12 edges (24 vertices, 72 floats)', () => {
    const v = aabbEdgeLineList([0, 0, 0], [1, 2, 3]);
    assert.equal(v.length, 72);
  });

  it('every coordinate is a corner of the AABB', () => {
    const v = aabbEdgeLineList([0, 0, 0], [1, 2, 3]);
    for (let i = 0; i < v.length; i += 3) {
      assert.ok(v[i] === 0 || v[i] === 1, `x ${v[i]} is a box corner`);
      assert.ok(v[i + 1] === 0 || v[i + 1] === 2, `y ${v[i + 1]} is a box corner`);
      assert.ok(v[i + 2] === 0 || v[i + 2] === 3, `z ${v[i + 2]} is a box corner`);
    }
  });

  it('each emitted edge has unit-length axis alignment (differs in exactly one axis)', () => {
    const v = aabbEdgeLineList([0, 0, 0], [4, 5, 6]);
    for (let e = 0; e < v.length; e += 6) {
      const dx = v[e] !== v[e + 3] ? 1 : 0;
      const dy = v[e + 1] !== v[e + 4] ? 1 : 0;
      const dz = v[e + 2] !== v[e + 5] ? 1 : 0;
      assert.equal(dx + dy + dz, 1, 'a box edge changes exactly one axis');
    }
  });
});
