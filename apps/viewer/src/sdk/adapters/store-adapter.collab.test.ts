/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import {
  pathForGuid,
  registerEntityMaps,
  registerEntityPath,
  registerStoreSlot,
  unregisterEntityPath,
} from '@/lib/collab/entity-paths.js';
import { deleteRemoteOverlayEntity } from '@/lib/collab/remote-entity-delete.js';
import { createStoreAdapter } from './store-adapter.js';
import type { StoreApi } from './types.js';

const MODEL = 'model';
let dataStore: IfcDataStore;
let ifc2x3Store: IfcDataStore;
let ifc5Store: IfcDataStore;
let reconstructedStore: IfcDataStore;

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
  reconstructedStore = await new IfcParser().parseColumnar(bytes.slice().buffer);
  registerStoreSlot(reconstructedStore, { slotId: 'm0', pathPrefix: '/m0' });
  registerEntityMaps(
    reconstructedStore,
    new Map([[2, '/m0/0room000000000000000000']]),
    new Map([['/m0/0room000000000000000000', 2]]),
  );
  const ifc2x3 = step.replace("FILE_SCHEMA(('IFC4'));", "FILE_SCHEMA(('IFC2X3'));");
  const ifc2x3Bytes = new TextEncoder().encode(ifc2x3);
  ifc2x3Store = await new IfcParser().parseColumnar(ifc2x3Bytes.slice().buffer);
  ifc5Store = Object.create(dataStore) as IfcDataStore;
  Object.defineProperty(ifc5Store, 'schemaVersion', { value: 'IFC5' });
});

type MirrorCall = { kind: 'create' | 'remove' | 'attribute'; args: unknown[] };

function fixture(
  canEdit = true,
  modelStore = dataStore,
  canMirrorCreate?: () => boolean,
) {
  const view = new MutablePropertyView(modelStore.properties, MODEL);
  const calls: MirrorCall[] = [];
  const state = {
    models: new Map([[MODEL, { id: MODEL, ifcDataStore: modelStore }]]),
    getMutationView: (modelId: string) => modelId === MODEL ? view : null,
    canCollabEdit: () => canEdit,
    mirrorEntityCreate: (...args: unknown[]) => {
      calls.push({ kind: 'create', args });
      if (canMirrorCreate?.() ?? true) {
        registerEntityPath(modelStore, args[1] as number, pathForGuid(modelStore, args[3] as string));
      }
    },
    mirrorEntityRemove: (...args: unknown[]) => {
      calls.push({ kind: 'remove', args });
      unregisterEntityPath(modelStore, args[1] as number);
    },
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

  it('allows a tombstoned source GlobalId to be reused', () => {
    const { adapter } = fixture();
    assert.equal(adapter.removeEntity({ modelId: MODEL, expressId: 2 }), true);
    assert.doesNotThrow(() => adapter.addEntity(MODEL, {
      type: 'IFCWALL',
      attributes: ['0wall000000000000000000', null, 'Replacement', null, null, null, null, null, '.NOTDEFINED.'],
    }));
  });

  it('allows GlobalId reuse after a peer removes the overlay entity', () => {
    const { adapter, view } = fixture();
    const attributes = ['0remote00000000000000000', null, 'First', null, null, null, null, null, '.NOTDEFINED.'];
    const first = adapter.addEntity(MODEL, { type: 'IFCWALL', attributes });
    assert.equal(deleteRemoteOverlayEntity(dataStore, view, first.expressId), true);
    assert.doesNotThrow(() => adapter.addEntity(MODEL, { type: 'IFCWALL', attributes }));
  });

  it('rejects a GlobalId already claimed by a reconstructed room path', () => {
    const { adapter, view } = fixture(true, reconstructedStore);
    const count = view.getMutations().length;
    assert.throws(() => adapter.addEntity(MODEL, {
      type: 'IFCWALL',
      attributes: ['0room000000000000000000', null, 'Duplicate room entity'],
    }), /already exists/);
    assert.equal(view.getMutations().length, count);
  });

  it('rejects GlobalId edits because room identity is path-keyed', () => {
    const { adapter, view } = fixture();
    const first = adapter.addEntity(MODEL, { type: 'IFCWALL', attributes: [
      '0first00000000000000000', null, 'First', null, null, null, null, null, '.NOTDEFINED.',
    ] });
    const before = view.getMutations().length;
    assert.throws(() => adapter.setPositionalAttribute(first, 0, '0second0000000000000000'), /immutable/);
    assert.equal(view.getMutations().length, before, 'a rejected identity edit cannot mutate the overlay');
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
    assert.deepEqual(calls.filter(call => call.kind === 'attribute').at(-1), {
      kind: 'attribute', args: [MODEL, 3, 'bsi::ifc::prop::Coordinates', [4, 5, 6]],
    });
    assert.equal(adapter.removeEntity(point), true);
    assert.deepEqual(calls.at(-1), { kind: 'remove', args: [MODEL, 3] });
  });

  it('registers every cyclic source path before publishing reference attributes', () => {
    const cyclicStore = Object.create(dataStore) as IfcDataStore;
    Object.defineProperty(cyclicStore, 'getEntity', {
      value: (expressId: number) => expressId === 3
        ? { expressId, type: 'IfcBooleanResult', attributes: ['.UNION.', '#4', '#4'] }
        : expressId === 4
          ? { expressId, type: 'IfcBooleanResult', attributes: ['.UNION.', '#3', '#3'] }
          : undefined,
    });
    const { adapter, calls } = fixture(true, cyclicStore, () => true);

    adapter.setPositionalAttribute({ modelId: MODEL, expressId: 3 }, 1, '#4');

    const creates = calls.filter(call => call.kind === 'create');
    assert.equal(creates.length, 2);
    assert.deepEqual(creates.map(call => call.args[5]), [{}, {}]);
    const attributes = calls.filter(call => call.kind === 'attribute');
    assert.deepEqual(
      attributes.find(call => call.args[1] === 3
        && call.args[2] === 'bsi::ifc::prop::FirstOperand')?.args[3],
      { 'ifc-lite::entityPath': '/ifc-lite-ref-4' },
    );
    assert.deepEqual(
      attributes.find(call => call.args[1] === 4
        && call.args[2] === 'bsi::ifc::prop::FirstOperand')?.args[3],
      { 'ifc-lite::entityPath': '/ifc-lite-ref-3' },
    );
  });

  it('retries source mirroring after collaboration is initially unavailable', () => {
    let available = false;
    const { adapter, calls } = fixture(true, ifc2x3Store, () => available);
    const point = { modelId: MODEL, expressId: 3 };

    adapter.setPositionalAttribute(point, 0, [4, 5, 6]);
    available = true;
    adapter.setPositionalAttribute(point, 0, [7, 8, 9]);

    const creates = calls.filter(call => call.kind === 'create');
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[0]?.args.slice(0, 4), [MODEL, 3, 'IFCCARTESIANPOINT', 'ifc-lite-ref-3']);
    assert.deepEqual(creates[1]?.args.slice(0, 4), [MODEL, 3, 'IFCCARTESIANPOINT', 'ifc-lite-ref-3']);
    assert.ok(calls.some(call => call.kind === 'attribute'
      && call.args[1] === 3
      && call.args[2] === 'bsi::ifc::prop::Coordinates'));
  });

  it('retries an unregistered overlay reference before encoding its path', () => {
    let available = false;
    const retryStore = Object.create(dataStore) as IfcDataStore;
    const { adapter, calls } = fixture(true, retryStore, () => available);
    const referenced = adapter.addEntity(MODEL, {
      type: 'IFCCOSTVALUE',
      attributes: ['Base', null, null, null, null, null, null, null, null, null],
    });
    available = true;
    adapter.addEntity(MODEL, {
      type: 'IFCCOSTVALUE',
      attributes: ['Total', null, null, null, null, null, null, null, '.ADD.', [`#${referenced.expressId}`]],
    });

    const retried = calls.filter(call => call.kind === 'create' && call.args[1] === referenced.expressId);
    assert.equal(retried.length, 2, 'the pre-room overlay entity must be published again');
    const parent = calls.filter(call => call.kind === 'create').at(-1);
    const components = (parent?.args[5] as Record<string, unknown>)['bsi::ifc::prop::Components'];
    assert.deepEqual(components, [{
      'ifc-lite::entityPath': pathForGuid(retryStore, retried[1]?.args[3] as string),
    }]);
  });

  it('attempts to publish a new entity even when its referenced room entity is unavailable', () => {
    const retryStore = Object.create(dataStore) as IfcDataStore;
    const { adapter, calls } = fixture(true, retryStore, () => false);

    const created = adapter.addEntity(MODEL, {
      type: 'IFCAPPLIEDVALUE',
      attributes: ['Total', null, '#3', null, null, null, null, null, null, null],
    });

    assert.ok(calls.some(call => call.kind === 'create' && call.args[1] === created.expressId));
  });

  it('publishes pending positional overrides when retrying overlay materialization', () => {
    let available = false;
    const retryStore = Object.create(dataStore) as IfcDataStore;
    const { adapter, calls } = fixture(true, retryStore, () => available);
    const created = adapter.addEntity(MODEL, {
      type: 'IFCCOSTVALUE',
      attributes: ['Original', null, 1, null, null, null, null, null, null, null],
    });
    adapter.setPositionalAttribute(created, 2, 2);

    available = true;
    adapter.setPositionalAttribute(created, 0, 'Renamed');

    const retryValue = calls.filter(call => call.kind === 'attribute'
      && call.args[1] === created.expressId
      && call.args[2] === 'bsi::ifc::prop::AppliedValue').at(-1);
    assert.equal(retryValue?.args[3], 2);
  });

  it('suffixes a source materialization path already owned by a live room entity', () => {
    const collisionStore = Object.create(dataStore) as IfcDataStore;
    const { adapter, calls } = fixture(true, collisionStore, () => true);
    adapter.addEntity(MODEL, {
      type: 'IFCWALL',
      attributes: ['ifc-lite-ref-3', null, 'Path owner', null, null, null, null, null, '.NOTDEFINED.'],
    });
    adapter.setPositionalAttribute({ modelId: MODEL, expressId: 3 }, 0, [4, 5, 6]);

    const sourceCreate = calls.find(call => call.kind === 'create' && call.args[1] === 3);
    assert.equal(sourceCreate?.args[3], 'ifc-lite-ref-3-1');
  });

  it('shares one bounded work budget across broad source reference attributes', () => {
    const broadStore = Object.create(dataStore) as IfcDataStore;
    const references = Array.from({ length: 5_000 }, () => '#4');
    Object.defineProperty(broadStore, 'getEntity', {
      value: (expressId: number) => expressId === 3
        ? { expressId, type: 'IfcBooleanResult', attributes: ['.UNION.', references, references] }
        : expressId === 4
          ? { expressId, type: 'IfcCartesianPoint', attributes: [[0, 0, 0]] }
          : undefined,
    });
    const { adapter, calls } = fixture(true, broadStore, () => true);

    assert.throws(
      () => adapter.setPositionalAttribute({ modelId: MODEL, expressId: 3 }, 1, '#4'),
      /traversal work budget/,
    );
    assert.deepEqual(calls, [], 'budget exhaustion must happen before any room shell is published');
  });

  it('uses IFC2X3 positional names and mirrors undefined as an explicit clear', () => {
    const { adapter, calls } = fixture(true, ifc2x3Store);
    const created = adapter.addEntity(MODEL, {
      type: 'IFCAPPROVALRELATIONSHIP',
      attributes: ['#1', '#2'],
    });

    assert.deepEqual(calls[0]?.args[5], {
      'bsi::ifc::prop::RelatedApproval': { 'ifc-lite::entityPath': '/0project000000000000000' },
      'bsi::ifc::prop::RelatingApproval': { 'ifc-lite::entityPath': '/0wall000000000000000000' },
    });
    adapter.setPositionalAttribute(created, 0, '#2');
    adapter.setPositionalAttribute(created, 0, undefined);
    const edits = calls.filter(call => call.kind === 'attribute');
    assert.deepEqual(edits, [
      {
        kind: 'attribute',
        args: [
          MODEL,
          created.expressId,
          'bsi::ifc::prop::RelatedApproval',
          { 'ifc-lite::entityPath': '/0wall000000000000000000' },
        ],
      },
      { kind: 'attribute', args: [MODEL, created.expressId, 'bsi::ifc::prop::RelatedApproval', null] },
    ]);
  });

  it('encodes STEP references as stable room paths before mirroring', () => {
    const { adapter, calls } = fixture();
    adapter.addEntity(MODEL, { type: 'IFCRELAGGREGATES', attributes: [
      '0relation000000000000000', null, null, null, '#1', ['#2'],
    ] });
    const attributes = calls.find(call => call.kind === 'create')?.args[5] as Record<string, unknown>;
    assert.deepEqual(attributes['bsi::ifc::prop::RelatingObject'], {
      'ifc-lite::entityPath': '/0project000000000000000',
    });
    assert.deepEqual(attributes['bsi::ifc::prop::RelatedObjects'], [{
      'ifc-lite::entityPath': '/0wall000000000000000000',
    }]);
  });

  it('encodes entity-valued branches of mixed SELECT attributes', () => {
    const { adapter, calls } = fixture(true, dataStore, () => true);
    adapter.addEntity(MODEL, {
      type: 'IFCAPPLIEDVALUE',
      attributes: ['Rate', null, '#3', null, null, null, null, null, null, null],
    });
    const appliedValue = calls.at(-1);
    assert.ok(appliedValue);
    assert.deepEqual(
      (appliedValue.args[5] as Record<string, unknown>)['bsi::ifc::prop::AppliedValue'],
      { 'ifc-lite::entityPath': '/ifc-lite-ref-3' },
    );
  });

  it('preserves scalar typed branches of mixed SELECT attributes', () => {
    const { adapter, calls } = fixture(true, dataStore, () => true);
    const scalar = { typed: { type: 'IfcLabel', value: '#3' } };
    adapter.addEntity(MODEL, {
      type: 'IFCAPPLIEDVALUE',
      attributes: ['Rate', null, scalar, null, null, null, null, null, null, null],
    });
    const appliedValue = calls.at(-1);
    assert.ok(appliedValue);
    assert.deepEqual(
      (appliedValue.args[5] as Record<string, unknown>)['bsi::ifc::prop::AppliedValue'],
      scalar,
    );
    assert.equal(calls.filter(call => call.kind === 'create').length, 1);
  });

  it('uses cross-schema reference metadata for IFC5 collaboration stores', () => {
    const { adapter, calls } = fixture(true, ifc5Store);
    adapter.addEntity(MODEL, { type: 'IFCRELAGGREGATES', attributes: [
      '0relation000000000000001', null, null, null, '#1', ['#2'],
    ] });
    const attributes = calls.find(call => call.kind === 'create')?.args[5] as Record<string, unknown>;
    assert.deepEqual(attributes['bsi::ifc::prop::RelatingObject'], {
      'ifc-lite::entityPath': '/0project000000000000000',
    });
    assert.deepEqual(attributes['bsi::ifc::prop::RelatedObjects'], [{
      'ifc-lite::entityPath': '/0wall000000000000000000',
    }]);
  });

  it('preserves reference-shaped strings in text-typed slots', () => {
    const { adapter, calls } = fixture();
    adapter.addEntity(MODEL, {
      type: 'IFCWALL',
      attributes: ['0text000000000000000000', null, '#2', null, null, null, null, null, '.NOTDEFINED.'],
    });
    const attributes = calls.find(call => call.kind === 'create')?.args[5] as Record<string, unknown>;
    assert.equal(attributes['bsi::ifc::prop::Name'], '#2');
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
