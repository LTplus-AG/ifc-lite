/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useFederatedGeometry } from './useFederatedGeometry.js';

const mesh = (id: number): MeshData => ({ expressId: id, geometryItemId: id, color: [1, 0, 0, 1],
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) });
const geometry = (meshes: MeshData[]): GeometryResult => ({ meshes, totalVertices: meshes.length * 3, totalTriangles: meshes.length, coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, hasLargeCoordinates: false } });
const model = (id: string, meshes: MeshData[]): FederatedModel => ({ ...fixtureModel(id), geometryResult: geometry(meshes) });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); });
function mounted(initial: Map<string, FederatedModel>) {
  let models = initial, version = 0;
  let indices = new Map([...models.keys()].map((id, i) => [id, i]));
  let current: GeometryResult | null = null;
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  function Probe() {
    current = useFederatedGeometry(models, null, indices, version);
    return <output>{current?.meshes.map(m => `${m.geometryItemId}:${m.modelIndex}`).join(',')}</output>;
  }
  cleanups.push(() => { act(() => root.unmount()); node.remove(); });
  return { node, draw: () => { act(() => root.render(<Probe />)); return current!; },
    update: (next: Map<string, FederatedModel>, nextIndices = indices, nextVersion = version) => {
      models = next; indices = nextIndices; version = nextVersion;
    } };
}

it('stamps only the new single-model streaming suffix without mutating source owners (#6537)', () => {
  const source = [mesh(1)], first = model('a', source), f = mounted(new Map([['a', first]]));
  let reads = 0;
  Object.defineProperty(source[0], 'color', { enumerable: true, get: () => { reads++; return [1, 0, 0, 1]; } });
  const before = f.draw(), wrapper = before.meshes[0];
  for (let i = 2; i <= 20; i++) {
    source.push(mesh(i));
    f.update(new Map([['a', { ...first, geometryResult: geometry(source) }]]));
    const next = f.draw();
    assert.equal(next.meshes, before.meshes, 'append keeps the array used by incremental viewport filtering');
    assert.equal(next.meshes[0], wrapper, 'existing wrappers remain stable');
    assert.equal(next.totalVertices, i * 3); assert.equal(next.totalTriangles, i);
  }
  assert.equal(reads, 1, 'twenty streaming publishes read the original mesh only once');
  assert.ok(source.every(m => m.modelIndex === undefined), 'source MeshData retains its original ownership');
  assert.ok(f.node.textContent?.endsWith('20:0'), 'the mounted consumer observes the appended suffix');
});

for (const grows of [false, true]) it(`replaces single-model ${grows ? 'growing' : 'same-size'} immutable geometry (#6537)`, () => {
  const f = mounted(new Map([['a', model('a', [mesh(1)])]])); const before = f.draw();
  f.update(new Map([['a', model('a', grows ? [mesh(2), mesh(3)] : [mesh(2)])]])); const after = f.draw();
  assert.notEqual(after.meshes, before.meshes); assert.equal(f.node.textContent, grows ? '2:0,3:0' : '2:0');
});

it('rebuilds for in-place content changes, shrink and changed stable owner index (#6537)', () => {
  const source = [mesh(1), mesh(2)], first = model('a', source), f = mounted(new Map([['a', first]]));
  const before = f.draw(); source[0] = mesh(3);
  f.update(new Map([['a', first]]), new Map([['a', 0]]), 1); const edited = f.draw();
  assert.notEqual(edited.meshes, before.meshes); assert.equal(f.node.textContent, '3:0,2:0');
  source.pop(); f.update(new Map([['a', { ...first, geometryResult: geometry(source) }]]));
  const shortened = f.draw(); assert.equal(f.node.textContent, '3:0'); assert.notEqual(shortened.meshes, edited.meshes);
  f.update(new Map([['a', first]]), new Map([['a', 7]])); const changedIndex = f.draw();
  assert.equal(f.node.textContent, '3:7'); assert.notEqual(changedIndex.meshes, shortened.meshes);
});

it('preserves ownership through one-to-many, visibility and many-to-one transitions (#6537)', () => {
  const a = model('a', [mesh(1)]), b = model('b', [mesh(2)]), f = mounted(new Map([['a', a]]));
  f.draw(); f.update(new Map([['a', a], ['b', b]]), new Map([['a', 0], ['b', 1]])); f.draw();
  assert.equal(f.node.textContent, '1:0,2:1');
  f.update(new Map([['a', { ...a, visible: false }], ['b', b]])); f.draw(); assert.equal(f.node.textContent, '2:1');
  f.update(new Map([['b', b]]), new Map([['b', 1]])); f.draw(); assert.equal(f.node.textContent, '2:1');
  f.update(new Map([['b', { ...b, visible: false }]])); f.draw(); assert.equal(f.node.textContent, '');
  f.update(new Map([['b', b]])); f.draw(); assert.equal(f.node.textContent, '2:1');
  assert.equal(a.geometryResult!.meshes[0].modelIndex, undefined); assert.equal(b.geometryResult!.meshes[0].modelIndex, undefined);
});


it('preserves point-cloud chunk identity and the surviving single-model owner (#4226, #6537)', () => {
  const cloud = { expressId: 9, chunk: { positions: new Float32Array([1, 2, 3]), pointCount: 1,
    bbox: { min: [1, 2, 3] as [number, number, number], max: [1, 2, 3] as [number, number, number] } } };
  const scan = model('scan', []); scan.geometryResult = { ...scan.geometryResult!, pointClouds: [cloud] };
  const f = mounted(new Map([['scan', scan]])); f.update(new Map([['scan', scan]]), new Map([['scan', 7]]));
  const after = f.draw();
  assert.equal(after.pointClouds?.[0].modelIndex, 7);
  assert.equal(after.pointClouds?.[0].chunk, cloud.chunk);
  assert.equal('modelIndex' in cloud, false);
});

it('clears the retained owner cache between model sessions (#6537)', () => {
  const source = [mesh(1)], a = model('a', source), f = mounted(new Map([['a', a]])); f.draw();
  f.update(new Map()); assert.equal(f.draw(), null);
  source[0] = mesh(2); f.update(new Map([['a', a]])); f.draw();
  assert.equal(f.node.textContent, '2:0', 'a newly loaded session cannot reuse cleared wrappers');
});


for (const count of [1, 2]) it(`drops released CPU buffers from cached wrappers for ${count} models (#6537)`, () => {
  const a = model('a', [mesh(1)]), b = model('b', [mesh(2)]);
  useViewerStore.setState({ ...fixtureModels(...(count === 1 ? [a] : [a, b])), geometryResult: a.geometryResult!,
    boundedGeometryMode: true, geometryContentVersion: 0 });
  let current: GeometryResult | null = null;
  const indices = new Map([['a', 0], ['b', 1]]);
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  function Probe() {
    const state = useViewerStore();
    current = useFederatedGeometry(state.models, state.geometryResult, indices, state.geometryContentVersion);
    return <output>{current?.meshes.map(m => `${m.expressId}:${m.positions.length}`).join(',')}</output>;
  }
  cleanups.push(() => { act(() => root.unmount()); node.remove(); });
  act(() => root.render(<Probe />));
  assert.equal(current!.meshes[0].positions.length, 9);
  act(() => useViewerStore.getState().releaseGeometryMemory());
  assert.equal(current!.meshes[0].positions.length, 0, 'cached wrappers must not retain buffers released by the canonical store action');
  assert.equal(current!.meshes[0].normals.length, 0); assert.equal(current!.meshes[0].indices.length, 0);
  assert.equal(useViewerStore.getState().geometryContentVersion, 0, 'release does not request a GPU reupload from emptied CPU buffers');
  assert.equal(node.textContent, count === 1 ? '1:0' : '1:0,2:9');
});
