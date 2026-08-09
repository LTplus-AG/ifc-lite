/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
} from '@ifc-lite/data';
import { isSourceBytes } from '@ifc-lite/parser';

import { buildIfcxDataStore } from './viewerModelIngest.js';

/**
 * Build a minimal IFCX parse-result shape: a populated entity table (so the
 * entity-table-backed getEntity/getEntitiesByType have data) plus empty-but-valid
 * property/quantity tables (so getProperties/getQuantities resolve to the tables
 * rather than throwing — the original "this.store.getQuantities is not a function").
 */
function makeIfcxResult() {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(2, strings);
  entityBuilder.add(1, 'IfcWall', '', 'Wall A', '', '');
  entityBuilder.add(2, 'IfcSlab', '', 'Slab B', '', '');
  return {
    fileSize: 0,
    entityCount: 2,
    parseTime: 0,
    strings,
    entities: entityBuilder.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: new RelationshipGraphBuilder().build(),
  };
}

describe('buildIfcxDataStore (IFCX selection accessor path)', () => {
  it('wires getQuantities/getProperties so selecting an entity does not throw', () => {
    const store = buildIfcxDataStore(makeIfcxResult(), new ArrayBuffer(0));

    // Regression: these were undefined on the IFCX store → TypeError on selection.
    assert.equal(typeof store.getQuantities, 'function');
    assert.equal(typeof store.getProperties, 'function');

    assert.ok(Array.isArray(store.getQuantities(1)), 'getQuantities returns an array');
    assert.ok(Array.isArray(store.getProperties(1)), 'getProperties returns an array');
  });

  it('serves getEntity from the populated IFCX entity table', () => {
    const store = buildIfcxDataStore(makeIfcxResult(), new ArrayBuffer(0));

    const wall = store.getEntity(1);
    assert.ok(wall, 'known id resolves to an entity');
    assert.equal(wall!.expressId, 1);
    assert.equal(wall!.type, 'IfcWall');
    assert.deepEqual(wall!.attributes, [], 'IFCX has no STEP attribute list');

    assert.equal(store.getEntity(2)?.type, 'IfcSlab');
    assert.equal(store.getEntity(999), null, 'unknown id → null (not a fabricated entity)');
  });

  it('serves getEntitiesByType from the entity table, case-insensitively', () => {
    const store = buildIfcxDataStore(makeIfcxResult(), new ArrayBuffer(0));

    const walls = store.getEntitiesByType('IfcWall');
    assert.equal(walls.length, 1);
    assert.equal(walls[0].expressId, 1);

    assert.equal(store.getEntitiesByType('ifcwall').length, 1, 'type match is case-insensitive');
    assert.deepEqual(store.getEntitiesByType('IfcDoor'), [], 'absent type → empty list');
  });
});

/**
 * The IFCX store is built through an `as unknown as IfcStoreData` cast, because
 * the IFCX tables do not have the STEP shape. That cast silences every field
 * inside the literal, so when `source` became an `IfcSourceBytes` accessor
 * (#2183) this producer went on handing over a bare `Uint8Array` and the
 * whole-monorepo typecheck stayed green.
 *
 * The damage was not theoretical: consumers converted in the same change call
 * `source.materialize()` (collab seeding, federation overlays, CSV/IDS/USD
 * export) and would have thrown `TypeError: materialize is not a function` for
 * every IFCX model, while `source.contentKey` returned `undefined` and silently
 * disabled grid and alignment overlays -- a failure with no error at all.
 *
 * So assert the contract at runtime here, where no cast can hide it.
 */
describe('buildIfcxDataStore source contract (#2183)', () => {
  const buffer = new TextEncoder().encode('{"header":{},"data":[]}').buffer as ArrayBuffer;

  it('produces an IfcSourceBytes accessor, not a raw Uint8Array', () => {
    const store = buildIfcxDataStore(makeIfcxResult(), buffer);
    assert.equal(isSourceBytes(store.source), true);
    assert.equal(store.source instanceof Uint8Array, false);
  });

  it('serves the accessor methods the converted consumers actually call', () => {
    const store = buildIfcxDataStore(makeIfcxResult(), buffer);
    // Each of these threw TypeError on a raw Uint8Array.
    assert.ok(store.source.materialize() instanceof Uint8Array);
    assert.equal(store.source.withMaterialized((b) => b.byteLength), buffer.byteLength);
    assert.equal(store.source.decodeUtf8(0, 1), '{');
    assert.equal(store.source.toTransferable().kind, 'contiguous');
  });

  it('exposes a non-null contentKey, so overlays are not silently skipped', () => {
    // sourceKey() is `store?.source.contentKey ?? null`; on a raw Uint8Array
    // that is `undefined ?? null` -> null, and every per-source overlay hook
    // bails on a null key without reporting anything.
    const store = buildIfcxDataStore(makeIfcxResult(), buffer);
    assert.equal(typeof store.source.contentKey, 'string');
    assert.ok((store.source.contentKey ?? '').length > 0);
  });

  it('carries the actual bytes, not an empty placeholder', () => {
    const store = buildIfcxDataStore(makeIfcxResult(), buffer);
    assert.equal(store.source.byteLength, buffer.byteLength);
    assert.equal(store.source.length, buffer.byteLength);
    // Lengths alone would pass on a zero-filled placeholder of the right size.
    assert.deepEqual(store.source.materialize(), new Uint8Array(buffer));
  });
});
