/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';

/** #7347: export timestamps vary; native schema, IDs, types and every attribute must not. */
async function nativeIfcGraph(bytes: Uint8Array) {
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  assert.ok(store.schemaVersion, 'native comparison requires a parsed IFC schema');
  // @raw-entity-enumeration-ok the complete parsed native graph is the invariant, including every express ID.
  const entities = [...store.entityIndex.byId.keys()].sort((a, b) => a - b).map(expressId => {
    const entity = store.getEntity(expressId);
    assert.ok(entity, `native comparison requires complete entity #${expressId}`);
    return { expressId, type: entity.type, attributes: entity.attributes };
  });
  return { schema: store.schemaVersion, entities };
}

export async function assertSameNativeIfcGraph(actual: Uint8Array, expected: Uint8Array, message?: string): Promise<void> {
  const [actualGraph, expectedGraph] = await Promise.all([nativeIfcGraph(actual), nativeIfcGraph(expected)]);
  assert.deepEqual(actualGraph, expectedGraph, message ?? 'Native IFC graph changed');
}
