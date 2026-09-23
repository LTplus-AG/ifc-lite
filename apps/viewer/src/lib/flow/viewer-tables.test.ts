/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5167 — the viewer provides `FlowHost.tables()`, so `table.joinByKey`'s tag
 * and property strategies run in the browser as they do in `ifc-lite flow
 * run`. Before this they failed at run time in the viewer only.
 *
 * Built on a real parsed model and the real `getOrCreateMutationView`, against
 * a minimal store — the same harness shape as `store-adapter-cost-undo.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { StoreApi } from '@/sdk/adapters/types.js';
import { viewerTableAccess } from './viewer-tables.js';

const STEP = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;', 'DATA;',
  "#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);",
  'ENDSEC;', 'END-ISO-10303-21;',
].join('\n');

async function storeWithModel(): Promise<{ store: StoreApi; views: Map<string, MutablePropertyView> }> {
  const bytes = new TextEncoder().encode(STEP);
  const dataStore = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const views = new Map<string, MutablePropertyView>();
  const model = { id: 'm', name: 't.ifc', ifcDataStore: dataStore, schemaVersion: 'IFC4', fileSize: 0, loadedAt: 0, idOffset: 0, maxExpressId: 1 };
  const state = {
    activeModelId: 'm',
    ifcDataStore: null,
    models: new Map([['m', model]]),
    getMutationView: (id: string) => views.get(id) ?? null,
    registerMutationView: (id: string, view: MutablePropertyView) => { views.set(id, view); },
  };
  return { store: { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi, views };
}

describe('viewerTableAccess (#5167)', () => {
  it('serves the active model’s entity table, strings and the store’s own mutation view', async () => {
    const { store, views } = await storeWithModel();
    const access = viewerTableAccess(store)();
    assert.ok(access, 'the active model has a table');
    assert.equal(access.entities, store.getState().models.get('m')!.ifcDataStore!.entities);
    // The SAME view the rest of the viewer edits through — a private copy
    // would match against pre-edit values, the overlay-blind read the viewer
    // has already shipped once.
    assert.equal(access.mutationView, views.get('m'));
  });

  it('answers an explicit model id, and nothing for a model that is not loaded', async () => {
    const { store } = await storeWithModel();
    assert.ok(viewerTableAccess(store)('m'));
    assert.equal(viewerTableAccess(store)('missing'), undefined);
  });
});
