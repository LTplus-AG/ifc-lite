/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The intersection-solid state machine (`clashSolidStatus` and friends): the
 * viewer's on-demand BIMcollab-style overlap solid. Pins that each setter
 * moves ONLY the fields its name says, and — the case a partial `set` bug
 * would miss — that switching straight from one terminal state to another
 * (solid -> unavailable, unavailable -> solid) leaves no field from the prior
 * state behind. A leftover `clashSolidMesh` after `setClashSolidUnavailable`
 * would be exactly the "stale solid from the previous selection" the task
 * warns against.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClashSlice, type ClashSlice } from './clashSlice.js';

describe('ClashSlice intersection-solid state', () => {
  let state: ClashSlice;

  beforeEach(() => {
    const setState = (
      partial: Partial<ClashSlice> | ((s: ClashSlice) => Partial<ClashSlice>),
    ) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createClashSlice(setState, () => state, {} as never);
  });

  it('starts at none with no mesh/reason', () => {
    assert.equal(state.clashSolidStatus, 'none');
    assert.equal(state.clashSolidMesh, null);
    assert.equal(state.clashSolidReason, null);
  });

  it('setClashSolidComputing clears any prior mesh/reason and sets status', () => {
    state.setClashSolid({ positions: new Float64Array([0, 0, 0]), indices: new Uint32Array([0]) }, 2.5);
    state.setClashSolidComputing();
    assert.equal(state.clashSolidStatus, 'computing');
    assert.equal(state.clashSolidMesh, null, 'a stale mesh from the PRIOR clash must not survive into "computing"');
    assert.equal(state.clashSolidVolumeM3, 0);
  });

  it('setClashSolid populates the mesh + volume and clears any prior unavailable reason', () => {
    state.setClashSolidUnavailable('below-kernel-resolution', 0.0001, 0.0003);
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    state.setClashSolid({ positions, indices }, 0.42);
    assert.equal(state.clashSolidStatus, 'solid');
    assert.equal(state.clashSolidMesh?.positions, positions);
    assert.equal(state.clashSolidMesh?.indices, indices);
    assert.equal(state.clashSolidVolumeM3, 0.42);
    // The previous 'unavailable' verdict must not leak through.
    assert.equal(state.clashSolidReason, null, 'a solid result must not carry the PRIOR unavailable reason');
    assert.equal(state.clashSolidThicknessM, 0);
    assert.equal(state.clashSolidRequiredM, 0);
  });

  it('setClashSolidUnavailable populates the reason/thickness/required and clears any prior mesh', () => {
    state.setClashSolid({ positions: new Float64Array([0, 0, 0]), indices: new Uint32Array([0]) }, 9);
    state.setClashSolidUnavailable('below-kernel-resolution', 0.00002, 0.00005);
    assert.equal(state.clashSolidStatus, 'unavailable');
    assert.equal(state.clashSolidReason, 'below-kernel-resolution');
    assert.equal(state.clashSolidThicknessM, 0.00002);
    assert.equal(state.clashSolidRequiredM, 0.00005);
    // The previous solid must not leak through — this is the literal "stale
    // solid from the previous selection" the verification brief calls out.
    assert.equal(state.clashSolidMesh, null, 'a degenerate result must not carry the PRIOR solid mesh');
    assert.equal(state.clashSolidVolumeM3, 0);
  });

  it('clearClashSolid resets every field back to the initial "none" shape', () => {
    state.setClashSolid({ positions: new Float64Array([0, 0, 0]), indices: new Uint32Array([0]) }, 3);
    state.clearClashSolid();
    assert.equal(state.clashSolidStatus, 'none');
    assert.equal(state.clashSolidMesh, null);
    assert.equal(state.clashSolidVolumeM3, 0);
    assert.equal(state.clashSolidReason, null);
    assert.equal(state.clashSolidThicknessM, 0);
    assert.equal(state.clashSolidRequiredM, 0);
  });

  it('a compute-error result is distinguishable from a kernel verdict', () => {
    state.setClashSolidUnavailable('compute-error', 0, 0);
    assert.equal(state.clashSolidReason, 'compute-error');
  });
});
