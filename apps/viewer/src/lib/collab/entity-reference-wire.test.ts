/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { registerEntityMaps } from './entity-paths.js';
import { decodeRoomAttributeValue, encodeRoomAttributeValue } from './entity-reference-wire.js';

test('structured room references resolve in the recipient ID space (#5008)', () => {
  const sender = {} as IfcDataStore, recipient = {} as IfcDataStore;
  registerEntityMaps(sender, new Map([[4, '/m0/target']]), new Map([['/m0/target', 4]]));
  registerEntityMaps(recipient, new Map([[91, '/m0/target']]), new Map([['/m0/target', 91]]));

  const encoded = encodeRoomAttributeValue(sender, ['#4', { typed: { type: 'IfcLabel', value: 'kept' } }]);
  assert.deepEqual(encoded, [{ 'ifc-lite::entityPath': '/m0/target' }, { typed: { type: 'IfcLabel', value: 'kept' } }]);
  assert.deepEqual(decodeRoomAttributeValue(recipient, encoded), {
    ok: true, value: ['#91', { typed: { type: 'IfcLabel', value: 'kept' } }],
  });
  assert.deepEqual(decodeRoomAttributeValue(recipient, { 'ifc-lite::entityPath': '/m0/missing' }), { ok: false });
});
