/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { createStoreAdapter } from './store-adapter.js';
import type { StoreApi } from './types.js';

const MODEL = 'model';
let dataStore: IfcDataStore;

before(async () => {
  const step = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('store.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;', 'DATA;',
    "#1=IFCPROJECT('0project000000000000000',$,'Project',$,$,$,$,$,$);",
    "#2=IFCWALL('0wall000000000000000000',$,'Existing',$,$,$,$,$,.NOTDEFINED.);",
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(step);
  dataStore = await new IfcParser().parseColumnar(bytes.slice().buffer);
});

type MirrorCall = { kind: 'create' | 'remove' | 'attribute'; args: unknown[] };

function fixture(canEdit = true) {
  const view = new MutablePropertyView(dataStore.properties, MODEL);
  const calls: MirrorCall[] = [];
  const state = {
    models: new Map([[MODEL, { id: MODEL, ifcDataStore: dataStore }]]),
    getMutationView: (modelId: string) => modelId === MODEL ? view : null,
    canCollabEdit: () => canEdit,
    mirrorEntityCreate: (...args: unknown[]) => calls.push({ kind: 'create', args }),
    mirrorEntityRemove: (...args: unknown[]) => calls.push({ kind: 'remove', args }),
    mirrorAttributeEdit: (...args: unknown[]) => calls.push({ kind: 'attribute', args }),
  } as unknown as ViewerState;
  const store: StoreApi = { getState: () => state, subscribe: () => () => {} };
  return { adapter: createStoreAdapter(store), calls, view };
}

describe('bim.store collaboration mirroring (#5008)', () => {
  it('mirrors generic create, positional update, and remove primitives', () => {
    const { adapter, calls } = fixture();
    const created = adapter.addEntity(MODEL, {
      type: 'IFCWALL',
      attributes: ['0created000000000000000', null, 'Created', null, null, null, null, null, '.NOTDEFINED.'],
    });
    adapter.setPositionalAttribute(created, 2, 'Renamed');
    assert.equal(adapter.removeEntity(created), true);

    assert.deepEqual(calls.find(call => call.kind === 'create')?.args.slice(0, 4), [
      MODEL, created.expressId, 'IFCWALL', '0created000000000000000',
    ]);
    assert.ok(calls.some(call => call.kind === 'attribute'
      && call.args[1] === created.expressId && call.args[2] === 'Name' && call.args[3] === 'Created'));
    assert.ok(calls.some(call => call.kind === 'attribute'
      && call.args[1] === created.expressId && call.args[2] === 'Name' && call.args[3] === 'Renamed'));
    assert.deepEqual(calls.at(-1), { kind: 'remove', args: [MODEL, created.expressId] });
  });

  it('gives same-express-ID non-roots collision-safe room identities before mirroring attributes', () => {
    const { adapter, calls } = fixture();
    const created = adapter.addEntity(MODEL, {
      type: 'IFCCOSTVALUE',
      attributes: ['Rate', null, 12.5, null, null, null, null, null, null, null],
    });
    const peer = fixture();
    const peerCreated = peer.adapter.addEntity(MODEL, {
      type: 'IFCCOSTVALUE',
      attributes: ['Rate', null, 12.5, null, null, null, null, null, null, null],
    });

    const roomKey = calls[0]?.args[3];
    const peerRoomKey = peer.calls[0]?.args[3];
    assert.equal(created.expressId, peerCreated.expressId);
    assert.match(String(roomKey), /^ifc-lite-store-[0-9a-f-]{36}$/);
    assert.match(String(peerRoomKey), /^ifc-lite-store-[0-9a-f-]{36}$/);
    assert.notEqual(roomKey, peerRoomKey);
    assert.ok(calls.some(call => call.kind === 'attribute'
      && call.args[1] === created.expressId && call.args[2] === 'AppliedValue' && call.args[3] === 12.5));
  });

  it('rejects read-only room writes before touching the local overlay', () => {
    const { adapter, calls, view } = fixture(false);
    assert.throws(() => adapter.addEntity(MODEL, { type: 'IFCWALL', attributes: [] }), /read-only/);
    assert.throws(() => adapter.setPositionalAttribute({ modelId: MODEL, expressId: 2 }, 2, 'Blocked'), /read-only/);
    assert.throws(() => adapter.removeEntity({ modelId: MODEL, expressId: 2 }), /read-only/);
    assert.equal(view.getMutations().length, 0);
    assert.deepEqual(calls, []);
  });
});
