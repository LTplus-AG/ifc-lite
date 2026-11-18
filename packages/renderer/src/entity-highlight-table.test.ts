/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { entityHighlightImage, entityHighlightedInImage, highlightKeepsFragment, MESH_FLAG_HIGHLIGHTED_ENTITIES, MESH_FLAG_ONE_ENTITY } from './entity-highlight-table.js';
import { MESH_FLAG_ENTITY_VISIBILITY } from './entity-visibility-table.js';
import { MESH_FLAG_RTE_DRAWABLE } from './mesh-rte-uniforms.js';

it('packs full scene ids sorted, drops what the u32 lane cannot hold, and finds exactly them (#10264 S3)', () => {
  const page2 = 5 + 0x1000000; // same low 24 bits as 5, another 2^24 page
  const image = entityHighlightImage([page2, 9, 5, -1, 1.5, 0xFFFFFFFF, 0]);
  assert.deepEqual([...image], [4, 0, 5, 9, page2]);
  for (const id of [0, 5, 9, page2]) assert.equal(entityHighlightedInImage(image, id), true, `${id}`);
  for (const id of [1, 6, 5 + 0x2000000, 0xFFFFFFFF]) assert.equal(entityHighlightedInImage(image, id), false, `${id}`);
  assert.equal(entityHighlightedInImage(entityHighlightImage([]), 0), false, 'the empty image highlights nothing');
  assert.equal(entityHighlightedInImage(new Uint32Array(16), 0), false, 'an all-zero buffer highlights nothing');
});

it('keeps every fragment without a mode bit, the table\'s with one, the named entity with the other', () => {
  const image = entityHighlightImage([3, 4]);
  assert.equal(highlightKeepsFragment(image, 1 | MESH_FLAG_RTE_DRAWABLE, 0, 99), true, 'copies and ordinary draws keep all');
  assert.equal(highlightKeepsFragment(image, MESH_FLAG_HIGHLIGHTED_ENTITIES, 0, 3), true);
  assert.equal(highlightKeepsFragment(image, MESH_FLAG_HIGHLIGHTED_ENTITIES, 0, 5), false);
  assert.equal(highlightKeepsFragment(image, MESH_FLAG_ONE_ENTITY, 5, 5), true, 'hover names any entity, in the table or not');
  assert.equal(highlightKeepsFragment(image, MESH_FLAG_ONE_ENTITY, 5, 3), false);
  const bits = [MESH_FLAG_HIGHLIGHTED_ENTITIES, MESH_FLAG_ONE_ENTITY, MESH_FLAG_ENTITY_VISIBILITY, MESH_FLAG_RTE_DRAWABLE, 1, 2, 4, 8, 32];
  assert.equal(new Set(bits).size, bits.length, 'the mode bits share flags.x with no other meaning');
  assert.equal(bits.reduce((a, b) => a | b, 0), bits.reduce((a, b) => a + b, 0), 'each is its own bit');
});
