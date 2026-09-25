/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MESH_FLAGS_BYTE_OFFSET, MESH_UNIFORM_OFFSET } from './mesh-rte-uniforms.js';
import { RelativeToEyeFrame } from './relative-to-eye.js';
import { matchesHoveredMesh, packHoverUniforms, type SelectionOutlineSource } from './selection-outline-frame.js';
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

/**
 * #5390 review: the hovered mesh's packed uniform must carry the frame's
 * section plane and clip box, with the `flags.y` bits `fs_main` reads, or
 * the hover outline traces geometry the section tool removed.
 */
describe('packHoverUniforms carries the section / clip state (#5390)', () => {
  const source = (over: Partial<SelectionOutlineSource>): SelectionOutlineSource => ({
    uniformBufferSize: 512,
    viewProj: new Float32Array(16),
    relativeToEyeFrame: new RelativeToEyeFrame(),
    selectedMeshes: [],
    allMeshes: [],
    hoveredId: 42,
    selectedModelIndex: undefined,
    section: undefined,
    sectionFlipped: undefined,
    clipBox: undefined,
    ...over,
  });
  const flagsY = (u: Float32Array) => new Uint32Array(u.buffer, MESH_FLAGS_BYTE_OFFSET, 2)[1];

  it('packs no clip bits when nothing is cut', () => {
    assert.equal(flagsY(packHoverUniforms(source({}), mesh(42))), 0);
  });

  it('packs the section plane with its enabled and flipped bits', () => {
    const u = packHoverUniforms(source({ section: { enabled: true, normal: [0, 1, 0], distance: 3 }, sectionFlipped: true }), mesh(42));
    assert.equal(flagsY(u), 0b011);
    assert.deepEqual([...u.subarray(MESH_UNIFORM_OFFSET.sectionPlane, MESH_UNIFORM_OFFSET.sectionPlane + 3)], [0, 1, 0]);
  });

  it('packs the clip box bit', () => {
    const u = packHoverUniforms(source({ clipBox: { enabled: true, min: [0, 0, 0], max: [1, 1, 1] } }), mesh(42));
    assert.equal(flagsY(u), 0b100);
  });
});
