/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A tabular store labelled 'IFC4' has bytes behind `source`, but they are not
 * STEP. Each path below reads or writes STEP records, and used to recognise a
 * store without them by the 'IFC5' label alone, so this one was let through.
 * They now read `sourceKind`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { listIonExportModels } from '@/components/viewer/export-model-selection.js';
import { resolveEnergyExportMutationSource } from '@/components/viewer/energy-export-source.js';
import { canUseIdsWorker } from '@/hooks/ids/canUseIdsWorker.js';
import { selectedSourceProducts } from '@/lib/analytic/selected-source-products.js';
import { exportRegistryModel } from '@/lib/registry/export-model.js';
import { requestRemesh } from '@/lib/remesh/remesh-service.js';
import { bindAlignment, useAlignmentToolState } from '@/lib/section/alignment-controller.js';
import { createExportAdapter } from '@/sdk/adapters/export-adapter.js';
import type { StoreApi } from '@/sdk/adapters/types.js';
import { hostedFillRefusal } from '@/store/slices/mutation-hosted-fill.js';
import { stairRailingRefusal } from '@/store/slices/mutation-stair-railing.js';
import { wallJoinRefusal } from '@/store/slices/mutation-wall-joins.js';

import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { WALL, tabularFixtureStore } from '@/test/tabular-store-fixture.js';

const MODEL_ID = 'tabular';

function install(): { store: IfcDataStore; model: FederatedModel } {
  const store = tabularFixtureStore({ source: new TextEncoder().encode('not STEP').buffer as ArrayBuffer });
  const model = {
    ...fixtureModel(MODEL_ID),
    name: 'model.3dm',
    schemaVersion: 'IFC4',
    ifcDataStore: store,
    geometryResult: { meshes: [], totalVertices: 0, totalTriangles: 0 },
    maxExpressId: WALL,
  } as unknown as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(model), selectedEntityIds: new Set([WALL]) });
  return { store, model };
}

describe('STEP-only paths refuse a tabular store whatever its schema label', () => {
  beforeEach(() => {
    useViewerStore.getState().resetViewerState();
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, mutationViews: new Map() });
  });
  afterEach(() => {
    useAlignmentToolState.setState({ choosing: false, busy: false, error: undefined });
  });

  it('the fixture is the case: an IFC4 label over bytes that are not STEP', () => {
    const { store } = install();
    assert.equal(store.schemaVersion, 'IFC4');
    assert.ok(store.source.byteLength > 0);
  });

  it('is not offered for a STEP upload', () => {
    install();
    assert.deepEqual(listIonExportModels(useViewerStore.getState().models, null), []);
  });

  it('takes no wall joins, hosted openings, stairs or railings', () => {
    install();
    const state = useViewerStore.getState();
    assert.match(wallJoinRefusal(state, MODEL_ID) ?? '', /IFC2X3, IFC4 and IFC4X3 models only/);
    assert.match(hostedFillRefusal(state, MODEL_ID) ?? '', /IFC2X3, IFC4 and IFC4X3 models only/);
    assert.match(stairRailingRefusal(state, MODEL_ID) ?? '', /IFC2X3, IFC4 and IFC4X3 models only/);
  });

  it('is not regenerated through the STEP exporter for an energy export', () => {
    const { store } = install();
    const mutationView = { hasPendingChanges: () => true } as unknown as MutablePropertyView;
    assert.equal(resolveEnergyExportMutationSource({ mutationView, dataStore: store, schemaVersion: 'IFC4' }), null);
  });

  it('is validated in process: the IDS worker would parse its bytes as STEP', () => {
    const { store } = install();
    const hadWorker = 'Worker' in globalThis;
    if (!hadWorker) Object.assign(globalThis, { Worker: class {} });
    try {
      assert.equal(canUseIdsWorker(store), false);
    } finally {
      if (!hadWorker) delete (globalThis as { Worker?: unknown }).Worker;
    }
  });

  it('is skipped by the analytic source decoder', () => {
    install();
    const state = useViewerStore.getState();
    const picked = selectedSourceProducts(state, 'products', (globalId) => ({ modelId: MODEL_ID, expressId: globalId }));
    assert.equal(picked.grouped.size, 0);
  });

  it('is refused by registry publishing', async () => {
    install();
    await assert.rejects(exportRegistryModel(), /Select an IFC STEP model/);
  });

  it('is refused by export.ifc', () => {
    install();
    const adapter = createExportAdapter(useViewerStore as unknown as StoreApi);
    assert.throws(() => adapter.ifc(undefined, {}), /has no IFC STEP source/);
  });

  it('is not remeshed from its bytes', async () => {
    install();
    const outcome = await requestRemesh(useViewerStore.getState, MODEL_ID, [WALL], 'shape');
    assert.deepEqual(outcome, { status: 'refused', reason: 'noSource' });
  });

  it('cannot carry an alignment section', async () => {
    install();
    await bindAlignment(MODEL_ID, WALL);
    assert.equal(useAlignmentToolState.getState().error, 'A STEP IFC alignment model is required');
  });
});
