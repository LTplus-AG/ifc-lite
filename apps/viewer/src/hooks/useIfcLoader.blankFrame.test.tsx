/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { serializeEntitySubgraph } from '@ifc-lite/export';
import { IfcAPI } from '@ifc-lite/wasm';
import { resolveRtcFrame } from '../../../../packages/geometry/src/rtc-frame.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records.js';
import { requestRemesh } from '@/lib/remesh/remesh-service.js';
import { skip, blankFile, load, wallMeshes, bounds, remeshCalls } from '@/test/blank-ifc-loader-harness.js';

describe('canonical blank file → author → real WASM remesh (#6232)', () => {
  for (const unit of ['METRE', 'MILLIMETRE'] as const) {
    it(`${unit}: zero-job streaming emits actual engine metadata before completion`, { skip }, async () => {
      // A blank hierarchy still supplies two spatial-product jobs that yield
      // no meshes. For the distinct zero-job engine invariant, export the
      // real project's forward closure (context and units, no products).
      const store = await new IfcParser().parseColumnar(await blankFile(unit).arrayBuffer(), { disableWorkerScan: true });
      const project = store.entityIndex.byType.get('IFCPROJECT')?.[0];
      assert.ok(project);
      const bytes = serializeEntitySubgraph(store, null, { targets: new Set([project]) }).bytes;
      const events: Array<Record<string, unknown>> = [];
      const api = new IfcAPI();
      try {
        api.buildPrePassStreaming(bytes, (event: Record<string, unknown>) => events.push(event), 25, null, false);
        const metaIndex = events.findIndex(event => event.type === 'meta');
        const completeIndex = events.findIndex(event => event.type === 'complete');
        assert.ok(metaIndex >= 0 && completeIndex > metaIndex, 'real zero-job prepass still reports producer metadata');
        assert.equal(events[completeIndex].totalJobs, 0);
        assert.equal(events[metaIndex].unitScale, unit === 'METRE' ? 1 : 0.001);
      } finally { api.clearPrePassCache(); api.free(); }
    });

    for (const count of [1, 2]) {
      it(`${unit}, ${count} models: blank primary can create a physical wall and Undo/Redo once`, { skip }, async () => {
        const file = blankFile(unit), api = new IfcAPI();
        let expectedFrame;
        try {
          const pre = api.buildPrePassOnce(new Uint8Array(await file.arrayBuffer()));
          expectedFrame = resolveRtcFrame(pre);
        } finally { api.clearPrePassCache(); api.free(); }
        const primary = await load(file);
        let peer: FederatedModel | undefined;
        if (count === 2) {
          peer = await load(blankFile(unit), 'peer');
          assert.ok(peer.idOffset > primary.maxExpressId, 'blank primary spatial ids reserve their federation range');
        }
        const state = useViewerStore.getState();
        const storey = primary.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
        assert.ok(storey);
        assert.ok(modelEditTarget(state, primary.id), 'the canonical modelling command opens its mutation view');
        const wall = state.addWall(primary.id, storey, { Start: [2, 3, 0], End: [6, 3, 0], Thickness: 0.2, Height: 3 });
        assert.ok('expressId' in wall, 'error' in wall ? wall.error : 'wall creation must succeed');
        const outcome = await requestRemesh(useViewerStore.getState, primary.id, [wall.expressId], 'created');
        assert.equal(outcome.status, 'applied', 'blank canonical load must preserve the engine frame for authoring');
        const loaded = useViewerStore.getState().models.get(primary.id);
        assert.ok(loaded?.geometryResult?.coordinateInfo?.wasmRtcFrame);
        assert.deepEqual(loaded.geometryResult.coordinateInfo.wasmRtcFrame, expectedFrame, 'retain the exact engine-selected frame');
        assert.equal(loaded.geometryResult.coordinateInfo.lengthUnitScale, unit === 'METRE' ? 1 : 0.001);
        assert.ok(loaded.maxExpressId > 0);
        const meshes = wallMeshes(primary.id, wall.expressId);
        assert.ok(meshes.length > 0 && meshes.some(mesh => mesh.indices.length > 0));
        const measured = bounds(meshes);
        for (const [actual, expected] of [[measured.min, [2, 2.9, 0]], [measured.max, [6, 3.1, 3]]] as const) {
          actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-5, `${value} vs ${expected[i]}`));
        }
        assert.equal(useViewerStore.getState().undoStacks.get(primary.id)?.length, 1);
        useViewerStore.getState().undo(primary.id);
        assert.equal(wallMeshes(primary.id, wall.expressId).length, 0);
        assert.equal(useViewerStore.getState().undoStacks.get(primary.id)?.length, 0);
        useViewerStore.getState().redo(primary.id);
        assert.equal((await requestRemesh(useViewerStore.getState, primary.id, [wall.expressId], 'created')).status, 'applied');
        assert.deepEqual(bounds(wallMeshes(primary.id, wall.expressId)), measured);
        assert.equal(useViewerStore.getState().undoStacks.get(primary.id)?.length, 1);
        if (peer) assert.equal(useViewerStore.getState().models.get(peer.id), peer, 'editing the primary never replaces its blank peer');
      });
    }
  }

  it('missing producer provenance still refuses remesh rather than assuming identity', { skip }, async () => {
    const model = await load(blankFile('METRE'));
    if (model.geometryResult?.coordinateInfo) {
      const unknownFrame = { ...model.geometryResult.coordinateInfo };
      delete unknownFrame.wasmRtcFrame;
      useViewerStore.getState().setGeometryResult({ ...model.geometryResult, coordinateInfo: unknownFrame });
    }
    const storey = model.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
    assert.ok(storey);
    assert.ok(modelEditTarget(useViewerStore.getState(), model.id));
    const wall = useViewerStore.getState().addWall(model.id, storey, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    assert.deepEqual(await requestRemesh(useViewerStore.getState, model.id, [wall.expressId], 'created'), { status: 'refused', reason: 'noFrame' });
    assert.equal(remeshCalls, 0, 'unknown producer provenance never reaches the real engine remesh');
  });
});
