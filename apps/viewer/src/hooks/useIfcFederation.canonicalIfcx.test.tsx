/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { useIfcLoader } from './useIfcLoader.js';
import { useIfcFederation } from './useIfcFederation.js';
import type { IfcxDataStore } from './ingest/ifcxComposition.js';

function source(name: string, data: unknown[]): File {
  return new File([JSON.stringify({ header: { ifcxVersion: 'ifcx-alpha' }, imports: [], schemas: {}, data })], name);
}
const image = { width: 1, height: 1, rgba: '/wAA/w==' };
const klass = (code: string) => ({ code, uri: `https://example.invalid/${code}` });
function base(): File {
  return source('base.ifcx', [
    { path: 'image', attributes: { 'ifclite::image::v1': image } },
    { path: 'wall', attributes: {
      'bsi::ifc::class': klass('IfcWall'), 'bsi::ifc::prop::Name': 'Base wall',
      'ifclite::appearance::v1': { image: { ref: 'image' }, repeatS: false, repeatT: true, uvs: [0, 0, 1, 0, 0, 1] },
      'usd::usdgeom::mesh': { points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faceVertexIndices: [0, 1, 2] },
    } },
    { path: 'scan', attributes: { 'bsi::ifc::class': klass('IfcGeographicElement'), 'points::array': { positions: [[10, 20, 30]] } } },
  ]);
}
let api: ReturnType<typeof useIfcFederation>;
let loader: ReturnType<typeof useIfcLoader>;
let root: Root;
let container: HTMLDivElement;
function Probe() {
  loader = useIfcLoader();
  api = useIfcFederation(loader.loadFile);
  return null;
}
beforeEach(async () => {
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('canonical IFCX composition retains points, layer order, accessors, source ownership and completion', async () => {
  // Invariant: layered and single-source IFCX use the same renderable payload conversion.
  await act(async () => api.loadFederatedIfcx([base()]));
  const first = useViewerStore.getState();
  const originalHash = first.models.get('layer-1')?.sourceContentHash;
  assert.ok(originalHash);
  assert.equal(first.models.size, 1);
  assert.deepEqual(Array.from(first.geometryResult!.meshes[0].texture!.rgba), [255, 0, 0, 255]);
  assert.equal(first.geometryResult?.pointClouds?.[0].chunk.pointCount, 1);
  assert.deepEqual(Array.from(first.geometryResult!.pointClouds![0].chunk.positions), [10, 30, -20]);
  const originalStore = first.ifcDataStore as IfcxDataStore;
  const retained = originalStore._federatedBuffers![0];
  const originalBytes = new Uint8Array(retained.buffer).slice();
  const wallId = first.layerStackPathToId!.get('wall')!;
  assert.equal(first.ifcDataStore!.getEntity(wallId)?.type, 'IfcWall');
  assert.equal(first.resolveGlobalIdFromModels(wallId)?.modelId, 'layer-1');
  assert.equal(first.models.get('layer-1')?.loadState, 'complete');
  useViewerStore.setState({ selectedEntityIds: new Set([wallId]), hiddenEntities: new Set([wallId]) });

  await act(async () => api.addIfcxOverlays([source('overlay.ifcx', [
    { path: 'wall', attributes: { 'bsi::ifc::prop::Name': 'Overlay wall' } },
  ])]));
  const composed = useViewerStore.getState();
  assert.equal(composed.error, null);
  assert.equal(composed.models.size, 2);
  assert.deepEqual([...composed.models.keys()], ['layer-2', 'layer-1']);
  assert.equal(composed.activeModelId, 'layer-1');
  assert.deepEqual(composed.layerStack.map(l => l.name), ['base.ifcx', 'overlay.ifcx']);
  assert.deepEqual((composed.ifcDataStore as IfcxDataStore)._federatedBuffers!.map(b => b.name), ['base.ifcx', 'overlay.ifcx']);
  assert.equal(composed.geometryResult?.meshes.length, 1);
  assert.deepEqual(Array.from(composed.geometryResult!.meshes[0].texture!.rgba), [255, 0, 0, 255]);
  assert.equal(composed.geometryResult?.pointClouds?.length, 1);
  assert.ok(composed.geometryResult!.coordinateInfo!.originalBounds.max.y >= 30);
  assert.equal(composed.selectedEntityIds.size, 0);
  assert.equal(composed.hiddenEntities.size, 0);
  const newId = composed.layerStackPathToId!.get('wall')!;
  assert.equal(composed.ifcDataStore!.entities.getName(newId), 'Overlay wall');
  assert.equal(composed.resolveGlobalIdFromModels(newId)?.modelId, 'layer-1');
  assert.notEqual(composed.models.get('layer-1')?.sourceContentHash, originalHash);
  assert.deepEqual(new Uint8Array(retained.buffer), originalBytes, 'recomposition never mutates the retained prior source');
  assert.notEqual((composed.ifcDataStore as IfcxDataStore)._federatedBuffers![0].buffer, retained.buffer);
  assert.equal(composed.loading, false);
  assert.equal(composed.progress?.percent, 100);
});

it('a pending layer read cannot replace a newer canonical load or publish its layer stack', async () => {
  const pending = base();
  const bytes = await pending.arrayBuffer();
  let release!: (buffer: ArrayBuffer) => void;
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  pending.arrayBuffer = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  let loading!: Promise<void>;
  await act(async () => { loading = api.loadFederatedIfcx([pending]); await reading; });
  await act(async () => loader.loadFile(source('winner.ifcx', [])));
  const winner = useViewerStore.getState().ifcDataStore;
  await act(async () => { release(bytes); await loading; });
  assert.equal(useViewerStore.getState().ifcDataStore, winner);
  assert.equal(useViewerStore.getState().layerStack.length, 0);
  assert.equal(useViewerStore.getState().models.size, 1);
  assert.equal([...useViewerStore.getState().models.values()][0].name, 'winner.ifcx');
});

it('strongest overlay tombstones remove geometry while retained resource opinions survive later recomposition', async () => {
  // Invariant: load convergence delegates composition semantics to the IFCX parser.
  await act(async () => api.loadFederatedIfcx([base(), source('delete.ifcx', [
    { path: 'wall', attributes: { 'ifclite::deleted': true } },
  ])]));
  assert.equal(useViewerStore.getState().error, null);
  assert.equal(useViewerStore.getState().geometryResult?.meshes.length, 0);
  assert.equal(useViewerStore.getState().geometryResult?.pointClouds?.length, 1);
  assert.equal(useViewerStore.getState().layerStackPathToId?.has('wall'), false);
  await act(async () => api.addIfcxOverlays([source('review.ifcx', [
    { path: 'scan', attributes: { 'bsi::ifc::prop::Name': 'Reviewed scan' } },
  ])]));
  const state = useViewerStore.getState();
  assert.equal(state.error, null);
  assert.equal(state.geometryResult?.meshes.length, 0);
  assert.equal(state.geometryResult?.pointClouds?.length, 1);
  assert.deepEqual(state.layerStack.map(l => l.name), ['base.ifcx', 'delete.ifcx', 'review.ifcx']);
  assert.deepEqual(state.layerStack[0].file.data.find(node => node.path === 'image')?.attributes?.['ifclite::image::v1'], image);
});

it('cancelling a layered read releases the load owner and leaves no late model or layer publication', async () => {
  const file = base();
  const bytes = await file.arrayBuffer();
  let release!: (buffer: ArrayBuffer) => void;
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  file.arrayBuffer = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  let pending!: Promise<void>;
  await act(async () => { pending = api.loadFederatedIfcx([file]); await reading; });
  const cancel = useViewerStore.getState().activeLoadCanceller;
  assert.equal(typeof cancel, 'function');
  await act(async () => { cancel!(); release(bytes); await pending; });
  const state = useViewerStore.getState();
  assert.equal(state.activeLoadCanceller, null);
  assert.equal(state.models.size, 0);
  assert.equal(state.layerStack.length, 0);
  assert.equal(state.geometryResult, null);
  assert.equal(state.ifcDataStore, null);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
});
