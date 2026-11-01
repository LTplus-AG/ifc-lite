/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';

function makeStore(searchFilter: unknown): StoreApi {
  return {
    getState: () => ({ searchFilter, models: new Map() }),
    subscribe: () => () => {},
  } as unknown as StoreApi;
}

test('entitiesMatchingActiveFilter returns null when no filter rules are active', () => {
  const adapter = createQueryAdapter(makeStore({ groups: [{ rules: [], combinator: 'AND' }], limit: 500 }));
  // null (not []) so callers can distinguish "no filter" from "zero matches".
  assert.equal(adapter.entitiesMatchingActiveFilter(), null);
});

test('entitiesMatchingActiveFilter returns null when the filter state is absent', () => {
  const adapter = createQueryAdapter(makeStore(undefined));
  assert.equal(adapter.entitiesMatchingActiveFilter(), null);
});

// #8425 review: the filtered export runs the evaluator with the same model
// meaning every other run gets: durable identity for `model` rules, live
// edits, and Lens custom groupings.
test('entitiesMatchingActiveFilter reads model identity, live edits and custom groupings', async () => {
  const { IfcParser } = await import('@ifc-lite/parser');
  const { MutablePropertyView } = await import('@ifc-lite/mutations');
  const { Rule } = await import('@ifc-lite/rules');
  const ifc = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,$,$);
#101= IFCWALL('0Wal100000000000000001',$,'W-Ext-1',$,$,$,$,$,$);
#102= IFCWALL('0Wal200000000000000002',$,'W-Int-1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;
  const bytes = new TextEncoder().encode(ifc);
  const ifcDataStore = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  view.setAttribute(102, 'Name', 'W-Ext-2');
  const lens = {
    id: 'lens-facade', name: 'Facade',
    rules: [{ id: 'r', name: 'Exterior', enabled: true, action: 'colorize', color: '#000000', groups: [{ combinator: 'AND', rules: [Rule.name('startsWith', 'W-Ext')] }] }],
  };
  const run = (rules: unknown[]) => createQueryAdapter({
    getState: () => ({
      searchFilter: { groups: [{ combinator: 'AND', rules }], limit: 500 },
      models: new Map([['m', { id: 'm', sourceFingerprint: 'fp-1', sourceContentHash: 'h', ifcDataStore }]]),
      modelTags: new Map(), modelTagAssignments: new Map(), mutationViews: new Map([['m', view]]),
      getMutationView: (id: string) => (id === 'm' ? view : null), savedLenses: [lens],
    }),
    subscribe: () => () => {},
  } as unknown as StoreApi).entitiesMatchingActiveFilter()?.map((e) => e.ref.expressId).sort();

  assert.deepEqual(run([Rule.ifcType(['IfcWall'], 'in'), Rule.model(['fp-1'], 'in')]), [101, 102], 'a model rule keyed by fingerprint matches');
  assert.deepEqual(run([Rule.name('startsWith', 'W-Ext')]), [101, 102], 'the live rename is read');
  assert.deepEqual(run([Rule.customGrouping({ name: 'Facade' }, 'in', ['Exterior'])]), [101, 102], 'the Lens grouping sees the rename too');
});
