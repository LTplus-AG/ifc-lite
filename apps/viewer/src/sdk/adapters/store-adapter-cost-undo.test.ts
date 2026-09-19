/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4857 PR A review — `bim.store.addCost*` (via `createStoreAdapter`) pushes
 * the same CREATE_ENTITY undo entry `addColumn`/etc. push, so a script-
 * authored cost entity is undoable. Exercises the real `createStoreAdapter`
 * against a minimal fake `StoreApi` (a real `MutablePropertyView`, a
 * `pushCreateEntityUndo` spy) rather than a full Zustand store.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { StoreApi } from './types.js';
import { createStoreAdapter } from './store-adapter.js';

const STEP = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;', 'DATA;',
  "#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);",
  'ENDSEC;', 'END-ISO-10303-21;',
].join('\n');

async function makeStore(): Promise<{ store: StoreApi; undoCalls: Array<{ modelId: string; entityId: number; ifcType: string }> }> {
  const bytes = new TextEncoder().encode(STEP);
  const dataStore = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const mutationViews = new Map<string, MutablePropertyView>();
  const undoCalls: Array<{ modelId: string; entityId: number; ifcType: string }> = [];
  const model = { id: 'm', name: 't.ifc', ifcDataStore: dataStore, schemaVersion: 'IFC4', fileSize: bytes.byteLength, loadedAt: 0, idOffset: 0, maxExpressId: 100 };
  const state = {
    activeModelId: 'm',
    ifcDataStore: null,
    models: new Map([['m', model]]),
    getMutationView: (id: string) => mutationViews.get(id) ?? null,
    registerMutationView: (id: string, view: MutablePropertyView) => { mutationViews.set(id, view); },
    pushCreateEntityUndo: (modelId: string, entityId: number, ifcType: string) => {
      undoCalls.push({ modelId, entityId, ifcType });
    },
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  return { store, undoCalls };
}

describe('#4857 store-adapter cost authoring pushes CREATE_ENTITY undo', () => {
  it('addCostItem pushes one undo entry naming the created expressId and IFCCOSTITEM', async () => {
    const { store, undoCalls } = await makeStore();
    const adapter = createStoreAdapter(store);
    const ref = adapter.addCostItem('m', { Name: 'Authored' });
    assert.equal(undoCalls.length, 1);
    assert.deepEqual(undoCalls[0], { modelId: ref.modelId, entityId: ref.expressId, ifcType: 'IFCCOSTITEM' });
  });

  it('addCostSchedule / addCostValue / addCostQuantity each push their own undo entry', async () => {
    const { store, undoCalls } = await makeStore();
    const adapter = createStoreAdapter(store);
    adapter.addCostSchedule('m', { Name: 'S' });
    adapter.addCostValue('m', { Name: 'V' });
    adapter.addCostQuantity('m', { Kind: 'IfcQuantityLength', Name: 'Q', Value: 1 });
    assert.deepEqual(undoCalls.map(c => c.ifcType), ['IFCCOSTSCHEDULE', 'IFCCOSTVALUE', 'IFCPHYSICALSIMPLEQUANTITY']);
  });
});
