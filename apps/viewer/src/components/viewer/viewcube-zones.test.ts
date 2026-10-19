/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CUBE_FACES,
  FACE_FRAMES,
  directionKey,
  faceOfDirection,
  isZoneHighlighted,
  zonesForFace,
} from './viewcube-zones';

describe('viewcube zones', () => {
  it('splits every face into one face, four edge and four corner cells', () => {
    for (const face of CUBE_FACES) {
      const zones = zonesForFace(face);
      assert.strictEqual(zones.length, 9);
      assert.strictEqual(zones.filter((z) => z.kind === 'face').length, 1);
      assert.strictEqual(zones.filter((z) => z.kind === 'edge').length, 4);
      assert.strictEqual(zones.filter((z) => z.kind === 'corner').length, 4);
    }
  });

  it('covers all 26 directions of the cube exactly, and all 12 edges', () => {
    const keys = new Set(CUBE_FACES.flatMap((f) => zonesForFace(f).map((z) => z.key)));
    assert.strictEqual(keys.size, 26);
    const edges = new Set(
      CUBE_FACES.flatMap((f) => zonesForFace(f).filter((z) => z.kind === 'edge').map((z) => z.key)),
    );
    assert.strictEqual(edges.size, 12);
  });

  it('shares each edge and corner between the faces that meet there', () => {
    const count = new Map<string, number>();
    for (const face of CUBE_FACES) {
      for (const z of zonesForFace(face)) count.set(z.key, (count.get(z.key) ?? 0) + 1);
    }
    for (const face of CUBE_FACES) {
      for (const z of zonesForFace(face)) {
        assert.strictEqual(count.get(z.key), z.kind === 'face' ? 1 : z.kind === 'edge' ? 2 : 3);
      }
    }
  });

  it('places cells where they sit on the face', () => {
    const front = zonesForFace('front');
    const at = (col: number, row: number) => front.find((z) => z.col === col && z.row === row)!.direction;
    assert.deepStrictEqual(at(0, 0), { x: 0, y: 0, z: 1 });
    assert.deepStrictEqual(at(0, -1), { x: 0, y: 1, z: 1 }); // top edge
    assert.deepStrictEqual(at(1, 0), { x: 1, y: 0, z: 1 }); // right edge
    assert.deepStrictEqual(at(-1, 1), { x: -1, y: -1, z: 1 }); // bottom-left corner
    // Top face seen from above: its upper cell borders the back face.
    const top = zonesForFace('top');
    assert.deepStrictEqual(top.find((z) => z.col === 0 && z.row === -1)!.direction, { x: 0, y: 1, z: -1 });
  });

  it('names only straight-on directions as faces', () => {
    assert.strictEqual(faceOfDirection({ x: 0, y: 0, z: -1 }), 'back');
    assert.strictEqual(faceOfDirection({ x: 1, y: 1, z: 0 }), null);
    assert.strictEqual(faceOfDirection({ x: 1, y: 1, z: 1 }), null);
  });

  it('previews a whole face on face hover, only the shared cells on edge hover', () => {
    const frontKey = directionKey(FACE_FRAMES.front.normal);
    for (const z of zonesForFace('front')) assert.strictEqual(isZoneHighlighted(z, 'front', frontKey), true);
    for (const z of zonesForFace('right')) assert.strictEqual(isZoneHighlighted(z, 'right', frontKey), z.key === frontKey);

    const edgeKey = directionKey({ x: 1, y: 0, z: 1 });
    const lit = CUBE_FACES.flatMap((f) => zonesForFace(f).filter((z) => isZoneHighlighted(z, f, edgeKey)));
    assert.strictEqual(lit.length, 2);
    assert.strictEqual(isZoneHighlighted(zonesForFace('front')[0], 'front', null), false);
  });
});
