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
import { createStandardRegistry } from '@ifc-lite/flow-nodes';
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

/**
 * #5377 review — express ids are per MODEL. Both models below have a wall
 * `#10`, with different marks. Before the fix, joinByKey matched every
 * candidate against the ACTIVE model's table and mapped the hit back by
 * express id alone: row "T-A" matched model A's #10 and came back as model
 * B's wall, so a later applyTable would have written to the wrong entity.
 */
describe('table.joinByKey across models (#5377)', () => {
  function wallModel(gid: string, mark: string): string {
    return [
      'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('t.ifc','',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
      "#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);",
      `#10=IFCWALL('${gid}',$,'Wall',$,$,$,$,$,$);`,
      `#100=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('${mark}'),$);`,
      "#101=IFCPROPERTYSET('0pset00000000000000p01',$,'Pset_Fabrication',$,(#100));",
      "#102=IFCRELDEFINESBYPROPERTIES('0rel000000000000000r01',$,$,$,(#10),#101);",
      'ENDSEC;', 'END-ISO-10303-21;',
    ].join('\n');
  }

  it('matches each candidate within its own model’s table', async () => {
    const parse = async (step: string) => {
      const bytes = new TextEncoder().encode(step);
      return new IfcParser().parseColumnar(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        { disableWorkerScan: true },
      );
    };
    const storeA = await parse(wallModel('0wallA0000000000000000', 'T-A'));
    const storeB = await parse(wallModel('0wallB0000000000000000', 'T-B'));
    const views = new Map<string, MutablePropertyView>();
    const modelOf = (id: string, dataStore: unknown) => ({ id, name: id, ifcDataStore: dataStore, schemaVersion: 'IFC4', fileSize: 0, loadedAt: 0, idOffset: 0, maxExpressId: 200 });
    const state = {
      activeModelId: 'A', // the ACTIVE model is A; every candidate is in B
      ifcDataStore: null,
      models: new Map([['A', modelOf('A', storeA)], ['B', modelOf('B', storeB)]]),
      getMutationView: (id: string) => views.get(id) ?? null,
      registerMutationView: (id: string, view: MutablePropertyView) => { views.set(id, view); },
    };
    const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
    const globalIds: Record<string, string> = { A: '0wallA0000000000000000', B: '0wallB0000000000000000' };
    const bim = { entity: (addr: { modelId: string; expressId: number }) => ({ globalId: globalIds[addr.modelId] }) };

    const join = createStandardRegistry().get('table.joinByKey');
    assert.ok(join, 'table.joinByKey is registered');
    const table = {
      columns: [{ name: 'Mark', type: 'string' as const }], key: 'Mark',
      rows: [{ Mark: 'T-A' }, { Mark: 'T-B' }],
    };
    const out = await join.run(
      { host: { bim, tables: viewerTableAccess(store), defaultModelId: 'A' }, laneKey: null, log: () => undefined } as never,
      { entities: [{ globalId: globalIds.B, modelId: 'B', expressId: 10 }], table },
      { strategy: 'property', column: 'Mark', pset: 'Pset_Fabrication', prop: 'Mark' },
    ) as { matched: { rows: Array<Record<string, unknown>> }; unmatched: { rows: Array<Record<string, unknown>> } };

    assert.deepEqual(out.matched.rows, [{ Mark: 'T-B', GlobalId: globalIds.B }], 'T-B matches B’s own wall');
    assert.deepEqual(out.unmatched.rows, [{ Mark: 'T-A' }], 'T-A is model A’s mark, not a candidate’s');
  });
});
