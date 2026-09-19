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
let ifc2x3Store: IfcDataStore;

before(async () => {
  const step = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('store.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;', 'DATA;',
    "#1=IFCPROJECT('0project000000000000000',$,'Project',$,$,$,$,$,$);",
    "#2=IFCWALL('0wall000000000000000000',$,'Existing',$,$,$,$,$,.NOTDEFINED.);",
    '#3=IFCCARTESIANPOINT((1.,2.,3.));',
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(step);
  dataStore = await new IfcParser().parseColumnar(bytes.slice().buffer);
  const ifc2x3 = step.replace("FILE_SCHEMA(('IFC4'));", "FILE_SCHEMA(('IFC2X3'));");
  const ifc2x3Bytes = new TextEncoder().encode(ifc2x3);
  ifc2x3Store = await new IfcParser().parseColumnar(ifc2x3Bytes.slice().buffer);
});

type MirrorCall = { kind: 'create' | 'remove' | 'attribute'; args: unknown[] };

function fixture(canEdit = true, modelStore = dataStore) {
  const view = new MutablePropertyView(modelStore.properties, MODEL);
  const calls: MirrorCall[] = [];
  const state = {
    models: new Map([[MODEL, { id: MODEL, ifcDataStore: modelStore }]]),
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
    assert.equal(
      (calls.find(call => call.kind === 'create')?.args[5] as Record<string, unknown>)['bsi::ifc::prop::Name'],
      'Created',
    );
    assert.ok(calls.some(call => call.kind === 'attribute'
      && call.args[1] === created.expressId
      && call.args[2] === 'bsi::ifc::prop::Name'
      && call.args[3] === 'Renamed'));
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
    assert.equal(
      (calls[0]?.args[5] as Record<string, unknown>)['bsi::ifc::prop::AppliedValue'],
      12.5,
    );
  });

  it('rejects an existing or locally claimed GlobalId before mutating the overlay', () => {
    const { adapter, calls, view } = fixture();
    const attributes = ['0created000000000000000', null, 'Created', null, null, null, null, null, '.NOTDEFINED.'];
    adapter.addEntity(MODEL, { type: 'IFCWALL', attributes });
    const count = view.getMutations().length;

    assert.throws(() => adapter.addEntity(MODEL, { type: 'IFCWALL', attributes }), /already exists/);
    assert.throws(() => adapter.addEntity(MODEL, {
      type: 'IFCWALL',
      attributes: ['0wall000000000000000000', null, 'Duplicate source', null, null, null, null, null, '.NOTDEFINED.'],
    }), /already exists/);
    assert.equal(view.getMutations().length, count);
    assert.equal(calls.filter(call => call.kind === 'create').length, 1);
  });

  it('releases a locally claimed GlobalId when its overlay entity is removed', () => {
    const { adapter } = fixture();
    const attributes = ['0reusable000000000000000', null, 'First', null, null, null, null, null, '.NOTDEFINED.'];
    const first = adapter.addEntity(MODEL, { type: 'IFCWALL', attributes });
    assert.equal(adapter.removeEntity(first), true);
    assert.doesNotThrow(() => adapter.addEntity(MODEL, { type: 'IFCWALL', attributes }));
  });

  it('preserves structured create and positional values on the collaboration wire', () => {
    const { adapter, calls } = fixture();
    const point = adapter.addEntity(MODEL, { type: 'IFCCARTESIANPOINT', attributes: [[1, 2, 3]] });
    assert.deepEqual(
      (calls[0]?.args[5] as Record<string, unknown>)['bsi::ifc::prop::Coordinates'],
      [1, 2, 3],
    );
    const typed = { typed: { type: 'IfcLengthMeasure', value: 4 } };
    adapter.setPositionalAttribute(point, 0, typed);
    assert.deepEqual(calls.at(-1), {
      kind: 'attribute',
      args: [MODEL, point.expressId, 'bsi::ifc::prop::Coordinates', typed],
    });
  });

  it('registers a stable room identity before editing and removing a source GUID-less entity', () => {
    const { adapter, calls } = fixture();
    const point = { modelId: MODEL, expressId: 3 };
    adapter.setPositionalAttribute(point, 0, [4, 5, 6]);
    assert.deepEqual(calls[0]?.args.slice(0, 4), [MODEL, 3, 'IFCCARTESIANPOINT', 'ifc-lite-ref-3']);
    assert.deepEqual(calls[1], {
      kind: 'attribute', args: [MODEL, 3, 'bsi::ifc::prop::Coordinates', [4, 5, 6]],
    });
    assert.equal(adapter.removeEntity(point), true);
    assert.deepEqual(calls.at(-1), { kind: 'remove', args: [MODEL, 3] });
  });

  it('uses IFC2X3 positional names and mirrors undefined as an explicit clear', () => {
    const { adapter, calls } = fixture(true, ifc2x3Store);
    const created = adapter.addEntity(MODEL, {
      type: 'IFCAPPROVALRELATIONSHIP',
      attributes: ['#1', '#2'],
    });

    assert.deepEqual(calls[0]?.args[5], {
      'bsi::ifc::prop::RelatedApproval': '#1',
      'bsi::ifc::prop::RelatingApproval': '#2',
    });
    adapter.setPositionalAttribute(created, 0, '#2');
    adapter.setPositionalAttribute(created, 0, undefined);
    const edits = calls.filter(call => call.kind === 'attribute');
    assert.deepEqual(edits, [
      { kind: 'attribute', args: [MODEL, created.expressId, 'bsi::ifc::prop::RelatedApproval', '#2'] },
      { kind: 'attribute', args: [MODEL, created.expressId, 'bsi::ifc::prop::RelatedApproval', null] },
    ]);
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
