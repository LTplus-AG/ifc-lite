/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchesHoveredMesh } from './selection-outline-frame.js';
import type { Mesh } from './types.js';

/**
 * The pure "is this the hovered mesh" predicate (#5390) that
 * `buildSelectionOutlineFrame` uses to find the hovered mesh among the
 * meshes the frame drew, honouring the same per-model disambiguation
 * `selectedMeshes` already filters by (see `index.ts`'s selection filter).
 */

function mesh(expressId: number, modelIndex?: number): Mesh {
  return { expressId, modelIndex, vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, transform: { m: new Float32Array(16) }, color: [1, 1, 1, 1] };
}

describe('matchesHoveredMesh (#5390)', () => {
  it('matches by express id when no model index is required', () => {
    assert.equal(matchesHoveredMesh(mesh(42), 42, undefined), true);
    assert.equal(matchesHoveredMesh(mesh(42), 43, undefined), false);
  });

  it('also requires the model index to match when one is given', () => {
    assert.equal(matchesHoveredMesh(mesh(42, 0), 42, 0), true);
    assert.equal(matchesHoveredMesh(mesh(42, 1), 42, 0), false);
  });

  it('treats an undefined mesh model index as not matching a specific requested index', () => {
    assert.equal(matchesHoveredMesh(mesh(42), 42, 0), false);
  });
});
