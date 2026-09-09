/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { AppearanceChange, Renderer } from '@ifc-lite/renderer';
import { appearanceHistoryParts } from './preview.js';

function fixture() {
  const before: MeshData = {
    expressId: 19, geometryItemId: 21,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
  };
  // UV-dependent welding may choose a different nearby normal representative.
  // The canonical target supplies that shading; triangle positions stay exact.
  const after = { ...before, normals: new Float32Array([0.0004, 0, 0.99999994, 0, 0, 1, 0, 0, 1]) };
  const change: AppearanceChange = { owner: { expressId: 19, modelIndex: 0 }, before: [before], after: [after] };
  const renderer = (current: MeshData) => ({ getScene: () => ({ getMeshDataPieces: () => [current] }) }) as unknown as Renderer;
  return { before, after, change, renderer };
}
describe('appearance history preserves canonical target shading (#4243)', () => {
  it('undoes and redoes the known normal transition on primary-model geometry', () => {
    const f = fixture();
    assert.deepEqual(appearanceHistoryParts(f.renderer(f.after), [f.change], 'undo')[0].parts[0].normals, f.before.normals);
    assert.deepEqual(appearanceHistoryParts(f.renderer(f.before), [f.change], 'redo')[0].parts[0].normals, f.after.normals);
  });
  it('refuses an unexpected current normal change instead of treating it as the saved transition', () => {
    const f = fixture(), changed = { ...f.after, normals: f.after.normals.slice() };
    changed.normals[0] = 0.25;
    assert.throws(() => appearanceHistoryParts(f.renderer(changed), [f.change], 'undo'), /geometry|topology|shading/);
  });
  it('still refuses a saved transition that moves triangle positions', () => {
    const f = fixture(), moved = { ...f.before, positions: f.before.positions.slice() };
    moved.positions[0] = 0.1;
    assert.throws(() => appearanceHistoryParts(f.renderer(f.after), [{ ...f.change, before: [moved] }], 'undo'), /geometry|topology/);
  });
  it('refuses a changed placement origin even when geometry arrays are shared', () => {
    const f = fixture(), moved: MeshData = { ...f.after, origin: [1, 0, 0] };
    assert.throws(() => appearanceHistoryParts(f.renderer(moved), [f.change], 'undo'), /geometry|topology/);
  });
});
