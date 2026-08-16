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

/**
 * `clearClashFocus` is the ONE complete spelling of "stop drawing the focused
 * clash" (#2654 review). Seven callers used to list the fields by hand and each
 * had drifted to a different subset — the failure mode being that `Viewport`
 * draws the contact marker from an effect keyed only on `clashContactLines` /
 * `clashOverlapBox`, so a teardown that dropped just the solid left a wireframe
 * hanging in world space. These pin the full field list in one place and pin
 * that `clearClash` cannot clear less than it does.
 */
describe('ClashSlice focused-clash presentation teardown', () => {
  let state: ClashSlice;

  /** Everything `focusClash` paints for one clash, all set at once. */
  function seedFullPresentation(): void {
    state.setClashSelectedId('rule-1 a:1 b:2');
    state.setClashHighlightColors(new Map([[1, [1, 0.6, 0, 1]]]));
    state.setClashOverlapBox({ min: [0, 0, 0], max: [1, 1, 1] });
    state.setClashContactLines({ vertices: [0, 0, 0, 1, 0, 0], color: [1, 0, 1, 1] });
    state.setClashSolid(
      { positions: new Float64Array([0, 0, 0]), indices: new Uint32Array([0]) },
      0.42,
    );
  }

  function assertNothingDrawn(where: string): void {
    assert.equal(state.clashSelectedId, null, `${where}: selected id`);
    assert.equal(state.clashHighlightColors, null, `${where}: A/B pair tint`);
    assert.equal(state.clashOverlapBox, null, `${where}: overlap wireframe box`);
    assert.equal(state.clashContactLines, null, `${where}: contact-line overlay`);
    assert.equal(state.clashSolidStatus, 'none', `${where}: solid status`);
    assert.equal(state.clashSolidMesh, null, `${where}: solid mesh`);
    assert.equal(state.clashSolidVolumeM3, 0, `${where}: solid volume`);
    assert.equal(state.clashSolidReason, null, `${where}: unavailable reason`);
    assert.equal(state.clashSolidThicknessM, 0, `${where}: thickness`);
    assert.equal(state.clashSolidRequiredM, 0, `${where}: required thickness`);
  }

  beforeEach(() => {
    const setState = (
      partial: Partial<ClashSlice> | ((s: ClashSlice) => Partial<ClashSlice>),
    ) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createClashSlice(setState, () => state, {} as never);
  });

  it('clearClashFocus drops every field the focused clash draws', () => {
    seedFullPresentation();
    state.clearClashFocus();
    assertNothingDrawn('clearClashFocus');
  });

  it('clearClashFocus invalidates an in-flight solid compute (seq bump)', () => {
    const seq = state.clashSolidRequestSeq;
    state.setClashSolidComputing();
    state.clearClashFocus();
    assert.ok(
      state.clashSolidRequestSeq > seq,
      'a compute that resolves after teardown must be dropped, not painted',
    );
  });

  it('clearClashFocus keeps the clash RESULT — it ends a presentation, not a run', () => {
    const result = { clashes: [] } as unknown as ClashSlice['clashResult'];
    state.setClashResult(result);
    seedFullPresentation();
    state.clearClashFocus();
    assert.equal(state.clashResult, result);
  });

  it('clearClash clears everything clearClashFocus does, and the result too', () => {
    // The drift guard: both spread the same `CLASH_FOCUS_RESET`, so a field
    // added to the presentation cannot be picked up by one and missed by the
    // other.
    const result = { clashes: [] } as unknown as ClashSlice['clashResult'];
    state.setClashResult(result);
    seedFullPresentation();
    state.clearClash();
    assertNothingDrawn('clearClash');
    assert.equal(state.clashResult, null, 'clearClash: result');
  });
});
