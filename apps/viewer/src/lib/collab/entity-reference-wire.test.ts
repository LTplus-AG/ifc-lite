/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { registerEntityMaps } from './entity-paths.js';
import { decodeRoomAttributeValue, encodeRoomAttributeEdit, encodeRoomAttributeValue } from './entity-reference-wire.js';

test('structured room references resolve in the recipient ID space (#5008)', () => {
  const sender = {} as IfcDataStore, recipient = {} as IfcDataStore;
  registerEntityMaps(sender, new Map([[4, '/m0/target']]), new Map([['/m0/target', 4]]));
  registerEntityMaps(recipient, new Map([[91, '/m0/target']]), new Map([['/m0/target', 91]]));

  assert.equal(encodeRoomAttributeValue(sender, '#4', false), '#4', 'reference-shaped text stays text');
  const encoded = encodeRoomAttributeValue(sender, ['#4', { typed: { type: 'IfcReference', value: '#4' } }], true);
  assert.deepEqual(encoded, [
    { 'ifc-lite::entityPath': '/m0/target' },
    { typed: { type: 'IfcReference', value: { 'ifc-lite::entityPath': '/m0/target' } } },
  ]);
  assert.deepEqual(decodeRoomAttributeValue(recipient, encoded), {
    ok: true, value: ['#91', { typed: { type: 'IfcReference', value: '#91' } }],
  });
  assert.deepEqual(decodeRoomAttributeValue(recipient, { 'ifc-lite::entityPath': '/m0/missing' }), {
    ok: false, reason: 'unresolved room reference: /m0/missing',
  });
});

test('mixed SELECT scalar markers preserve reference-shaped text (#5008)', () => {
  const sender = {} as IfcDataStore;
  registerEntityMaps(sender, new Map([[4, '/m0/target']]), new Map([['/m0/target', 4]]));
  const scalar = { typed: { type: 'IfcLabel', value: '#4' } };
  assert.deepEqual(encodeRoomAttributeValue(sender, scalar, true), scalar);
});

test('named outbound edits encode only schema-declared reference slots (#5008)', () => {
  const sender = {
    schemaVersion: 'IFC2X3',
    entities: { getTypeName: (id: number) => id === 1 ? 'IfcApprovalRelationship' : 'IfcWall' },
    getEntity: (id: number) => ({ expressId: id, type: id === 1 ? 'IfcApprovalRelationship' : 'IfcWall', attributes: [] }),
  } as unknown as IfcDataStore;
  registerEntityMaps(sender, new Map([[4, '/m0/target']]), new Map([['/m0/target', 4]]));

  assert.deepEqual(encodeRoomAttributeEdit(sender, 1, 'RelatedApproval', '#4'), {
    'ifc-lite::entityPath': '/m0/target',
  });
  assert.equal(encodeRoomAttributeEdit(sender, 2, 'Name', '#4'), '#4');
});

test('structured room transforms reject excessive nesting without recursion (#5008)', () => {
  const sender = {} as IfcDataStore;
  let deep: unknown = '#4';
  for (let index = 0; index < 300; index += 1) deep = [deep];
  assert.throws(() => encodeRoomAttributeValue(sender, deep, true), /exceeds depth 256/);
  assert.deepEqual(decodeRoomAttributeValue(sender, deep), {
    ok: false, reason: 'collaboration attribute value exceeds depth 256',
  });
});

test('structured room transforms enforce a bounded work budget (#5008)', () => {
  const sender = {} as IfcDataStore;
  const wide = new Array<unknown>(10_001).fill(null);
  assert.throws(() => encodeRoomAttributeValue(sender, wide, true), /exceeds 10000 nodes/);
  assert.deepEqual(decodeRoomAttributeValue(sender, wide), {
    ok: false, reason: 'collaboration attribute value exceeds 10000 nodes',
  });
});
