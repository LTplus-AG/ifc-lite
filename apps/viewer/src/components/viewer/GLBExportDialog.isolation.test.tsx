/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4328 follow-up: an ACTIVE isolation filter that matches nothing must
 * export NOTHING, not silently fall back to the whole model.
 * `resolveExportVisibility` already distinguishes "no filter" (`null`) from
 * "filter active, zero matches" (empty-but-non-null `Set`) — see
 * `exportVisibility.ts` and its tests. This file pins the two GLB assemblers
 * (from-meshes, the default; from-bytes/wasm, the source-fidelity fast path)
 * preserving that distinction all the way to the meshes / wasm call they
 * hand off to, instead of collapsing it back to a boolean the way
 * `hasIsolation = !!set && set.size > 0` and `toLocal`'s `!set || set.size
 * === 0` used to.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryProcessor, type MeshData, type GeometryResult } from '@ifc-lite/geometry';
import { render, cleanup, click, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { GLBExportDialog } from './GLBExportDialog';

afterEach(() => { cleanup(); mock.restoreAll(); });
beforeEach(() => { useViewerStore.getState().resetViewerState(); });

const zero = { x: 0, y: 0, z: 0 };
const coordinateInfo = {
  originalBounds: { min: zero, max: zero },
  shiftedBounds: { min: zero, max: zero },
  originShift: zero,
  hasLargeCoordinates: false,
};

function twoMeshGeometry(): GeometryResult {
  const mesh = (expressId: number): MeshData => ({
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    origin: [0, 0, 0],
  });
  return { meshes: [mesh(1), mesh(2)], totalTriangles: 2, totalVertices: 6, coordinateInfo };
}

/** Open the dialog, flip "Export Visible Only" on, and click "Export". */
async function exportVisibleOnly(): Promise<void> {
  const button = (label: string) => {
    const el = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    assert.ok(el, `no button labelled "${label}"`);
    return el;
  };
  render(<GLBExportDialog />);
  click(button('Export GLB'));
  await advance(1);
  const visibleOnlySwitch = document.querySelector('button[role="switch"]');
  assert.ok(visibleOnlySwitch, 'no "Export Visible Only" switch');
  click(visibleOnlySwitch);
  await advance(1);
  click(button('Export'));
  await advance(20);
}

it('from-meshes: a classFilter matching nothing in this model exports zero meshes, not the whole model', async () => {
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), maxExpressId: 2 }),
    // Global id 501 belongs to no loaded model's range (this model's ids top
    // out at 2, per `maxExpressId`) — the reachable #4328 scenario: the Class
    // tab filter matches a type present only in a federated model's OTHER
    // member.
    classFilter: { ids: new Set([501]), label: 'IfcWallStandardCase' },
  });
  useViewerStore.setState((s) => ({ models: new Map(s.models).set('m', { ...s.models.get('m')!, geometryResult: twoMeshGeometry() }) }));
  let exported: MeshData[] | undefined;
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  mock.method(GeometryProcessor.prototype, 'exportGlbFromMeshes', (meshes: MeshData[]) => { exported = meshes; return new Uint8Array([1]); });
  await exportVisibleOnly();
  assert.ok(exported, 'exportGlbFromMeshes must still run');
  assert.deepEqual(exported, [], 'an active filter matching nothing must export zero meshes');
});

it('from-meshes: no classFilter still exports every mesh (visible-only, no active isolation)', async () => {
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), maxExpressId: 2 }), classFilter: null });
  useViewerStore.setState((s) => ({ models: new Map(s.models).set('m', { ...s.models.get('m')!, geometryResult: twoMeshGeometry() }) }));
  let exported: MeshData[] | undefined;
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  mock.method(GeometryProcessor.prototype, 'exportGlbFromMeshes', (meshes: MeshData[]) => { exported = meshes; return new Uint8Array([1]); });
  await exportVisibleOnly();
  assert.equal(exported?.length, 2, 'no active isolation filter: both meshes stay visible');
});

it('from-meshes: a classFilter matching one id exports exactly that mesh', async () => {
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), maxExpressId: 2 }),
    classFilter: { ids: new Set([1]), label: 'IfcWallStandardCase' },
  });
  useViewerStore.setState((s) => ({ models: new Map(s.models).set('m', { ...s.models.get('m')!, geometryResult: twoMeshGeometry() }) }));
  let exported: MeshData[] | undefined;
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  mock.method(GeometryProcessor.prototype, 'exportGlbFromMeshes', (meshes: MeshData[]) => { exported = meshes; return new Uint8Array([1]); });
  await exportVisibleOnly();
  assert.equal(exported?.length, 1, 'a non-empty allowlist exports exactly its match, not everything and not nothing');
  assert.equal(exported?.[0]?.expressId, 1);
});

it('from-bytes (wasm): a classFilter matching nothing passes an ACTIVE empty isolated array, not undefined', async () => {
  const sourceFile = new File(['unused by the mock'], 'model.ifc');
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), maxExpressId: 2, sourceFile, geometryResult: twoMeshGeometry() }),
    classFilter: { ids: new Set([501]), label: 'IfcWallStandardCase' },
  });
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  let calledIsolated: Uint32Array | undefined = new Uint32Array([9, 9]); // sentinel, overwritten by the call
  let called = false;
  mock.method(GeometryProcessor.prototype, 'exportGlb', (
    _buf: Uint8Array, _meta: boolean, _hidden: Uint32Array, isolated: Uint32Array | undefined,
  ) => { called = true; calledIsolated = isolated; return new Uint8Array([1]); });
  await exportVisibleOnly();
  assert.ok(called, 'the from-bytes path must have run');
  assert.notEqual(calledIsolated, undefined, 'an ACTIVE isolation filter must not be passed as `undefined` (that means "no filter" at the wasm boundary)');
  assert.equal(calledIsolated?.length, 0, 'matching nothing: the isolated array is active but empty');
});

it('from-bytes (wasm): no classFilter passes isolated as undefined (no filter, not an active-empty one)', async () => {
  const sourceFile = new File(['unused by the mock'], 'model.ifc');
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m', { idOffset: 0 }), maxExpressId: 2, sourceFile, geometryResult: twoMeshGeometry() }),
    classFilter: null,
  });
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  let calledIsolated: Uint32Array | undefined = new Uint32Array([9, 9]);
  let called = false;
  mock.method(GeometryProcessor.prototype, 'exportGlb', (
    _buf: Uint8Array, _meta: boolean, _hidden: Uint32Array, isolated: Uint32Array | undefined,
  ) => { called = true; calledIsolated = isolated; return new Uint8Array([1]); });
  await exportVisibleOnly();
  assert.ok(called, 'the from-bytes path must have run');
  assert.equal(calledIsolated, undefined, 'no active isolation filter: `isolated` must be `undefined`, not an empty array');
});
