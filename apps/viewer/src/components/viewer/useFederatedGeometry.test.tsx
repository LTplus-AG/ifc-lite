/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { fixtureModel } from '@/test/store-fixture.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';

const coordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};
function mesh(id: number, item = id, x = 0): MeshData {
  return { expressId: id, geometryItemId: item, color: [1, 1, 1, 1],
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
}
function geometry(meshes: MeshData[]): GeometryResult {
  return { meshes, totalTriangles: meshes.length, totalVertices: meshes.length * 3, coordinateInfo };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); });
function mounted() {
  let models = new Map([['a', { ...fixtureModel('a'), geometryResult: geometry([mesh(1)]) }],
    ['b', { ...fixtureModel('b'), geometryResult: geometry([mesh(2, 20)]) }]]);
  const indices = new Map([['a', 0], ['b', 1]]);
  let current: GeometryResult | null = null;
  function Probe() { current = useFederatedGeometry(models, null, indices, 0); return <output>{current?.meshes.map(m => m.geometryItemId).join(',')}</output>; }
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  const draw = () => { act(() => root.render(<Probe />)); return current!; };
  cleanups.push(() => { act(() => root.unmount()); node.remove(); });
  return { draw, node, replace(meshes: MeshData[]) { models = new Map(models).set('b', { ...models.get('b')!, geometryResult: geometry(meshes) }); },
    append(part: MeshData) { models.get('b')!.geometryResult!.meshes.push(part); models = new Map(models); } };
}
for (const grows of [false, true]) it(`replaces federated owner geometry for ${grows ? 'growing' : 'same-size'} immutable arrays (#4451)`, () => {
  const f = mounted(); const before = f.draw();
  const replacement = mesh(2, 21, 5);
  f.replace(grows ? [replacement, mesh(3)] : [replacement]); const after = f.draw();
  assert.notEqual(after.meshes, before.meshes);
  assert.equal(f.node.textContent, grows ? '1,21,3' : '1,21');
  assert.equal(after.meshes.find(m => m.expressId === 2)?.positions, replacement.positions);
  assert.equal(after.meshes.find(m => m.expressId === 2)?.modelIndex, 1);
  assert.equal(after.meshes.filter(m => m.expressId === 2).length, 1);
});
it('retains cached wrappers for same-array streaming append (#4451)', () => {
  const f = mounted(), before = f.draw(), original = before.meshes[1];
  f.append(mesh(3)); const after = f.draw();
  assert.equal(after.meshes, before.meshes);
  assert.equal(after.meshes[1], original);
  assert.equal(f.node.textContent, '1,20,3');
});
