/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act, useState } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { StoreApi } from 'zustand';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { activeGeometryBackingTap, geometryBackingCommand } from '@/lib/geometry-backing/backing-debug-hook';
import type { TapState } from '@/lib/geometry-backing/store-backing-tap';
import { useViewPdfSource } from './useViewPdfSource';

/** Position buffers the resident source used before the release: a read-back source must not hold them. */
const residentBuffers = new Set<ArrayBufferLike>();
let lastBuffers: ArrayBufferLike[] = [];
let lastSource: unknown = null;
let rerender: () => void = () => undefined;
function Probe() {
  const [, setTick] = useState(0);
  rerender = () => setTick((tick) => tick + 1); // the dialog re-renders for unrelated reasons too
  const { source, status } = useViewPdfSource(true, []);
  const meshes = source?.view.meshes ?? [];
  const pinned = meshes.some((m) => residentBuffers.has(m.positions.buffer));
  lastBuffers = meshes.map((m) => m.positions.buffer);
  lastSource = source;
  return <output>{JSON.stringify({ status, meshes: meshes.length, arrays: meshes.every((m) => m.positions.length > 0) && !pinned })}</output>;
}

function model(name: string) {
  const mesh = (id: number, z: number): MeshData => ({ expressId: id, ifcType: 'IfcWall',
    positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]), normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] });
  const meshes = [mesh(1, 0), mesh(2, 3)];
  const geometryResult: GeometryResult = { meshes, totalTriangles: 2, totalVertices: 6, coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
    hasLargeCoordinates: false, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 3 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 3 } } } };
  useViewerStore.setState({ models: new Map([[name, { ...fixtureModel(name), geometryResult, ifcDataStore: null, maxExpressId: 10 }]]),
    geometryResult, activeModelId: name });
  return meshes;
}

async function until(read: () => { status: string; arrays: boolean }, want: (v: { status: string; arrays: boolean }) => boolean) {
  for (let i = 0; i < 100; i++) {
    if (want(read())) return read();
    await act(async () => { rerender(); await new Promise((r) => setTimeout(r, 20)); });
  }
  return read();
}

it('#10887 releasing CPU geometry while the PDF dialog is open switches its source to read-back arrays', async () => {
  const initial = useViewerStore.getState();
  const meshes = model('pdf-open');
  const store = useViewerStore as unknown as StoreApi<TapState>;
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: { database: { name: `pdf-open-${process.pid}`, locks: null } } as never });
    await geometryBackingCommand(store, undefined, { action: 'seal' });
    const ui = render(<Probe />);
    const read = () => JSON.parse(ui.querySelector('output')!.textContent!);
    assert.deepEqual(read(), { status: 'ready', meshes: 2, arrays: true }, 'resident source');
    for (const buffer of lastBuffers) residentBuffers.add(buffer); // what the open dialog's resident source holds
    const residentSourceBefore = lastSource;
    act(() => releaseCpuMeshBuffers(meshes));
    assert.ok(residentSourceBefore);
    const residentSource = lastSource;
    const after = await until(read, (v) => v.status === 'ready' && v.arrays && lastSource !== residentSource);
    assert.notEqual(lastSource, residentSource, 'the source cached before the release must not survive it');
    assert.deepEqual(after, { status: 'ready', meshes: 2, arrays: true }, 'read back, never the cached source pinning the released CPU arrays');
  } finally {
    cleanup();
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
  }
});

it('#10887 an open dialog that could not read back yet recovers when the backing completes, without reopening', async () => {
  const initial = useViewerStore.getState();
  const meshes = model('pdf-late');
  const store = useViewerStore as unknown as StoreApi<TapState>;
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: { database: { name: `pdf-late-${process.pid}`, locks: null } } as never });
    await activeGeometryBackingTap()!.whenIdle(); // records written, but not yet acknowledged complete
    releaseCpuMeshBuffers(meshes);
    const ui = render(<Probe />);
    const read = () => JSON.parse(ui.querySelector('output')!.textContent!);
    const waiting = await until(read, (v) => v.status === 'unavailable');
    assert.equal(waiting.status, 'unavailable', 'an explicit state, not an empty view');
    await act(async () => { await geometryBackingCommand(store, undefined, { action: 'seal' }); });
    const after = await until(read, (v) => v.status === 'ready');
    assert.deepEqual(after, { status: 'ready', meshes: 2, arrays: true });
  } finally {
    cleanup();
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
  }
});
