/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { ParquetExporter } from './parquet-exporter.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView as LiveMutablePropertyView } from '@ifc-lite/mutations';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  RelationshipGraphBuilder,
  QuantityTableBuilder,
  PropertyValueType,
  RelationshipType,
} from '@ifc-lite/data';
import { tableFromIPC } from 'apache-arrow';
import { readParquet } from 'parquet-wasm';

// #2046: ParquetExporter walked `dataStore` tables directly (column-copy, no
// per-entity loop) and never accepted a `MutablePropertyView`, so it was
// blind to ALL overlay state, deletions included. StepExporter/Ifc5Exporter
// already resolve this via `getEffectiveEntityIndex(...).isDeleted()`
// (#2036, #2047). This file pins the deletion half only.

/** Decode a Parquet buffer back to plain row objects for assertions. */
function decodeParquet(bytes: Uint8Array): Record<string, unknown>[] {
  const readTable = readParquet(bytes);
  const ipc = readTable.intoIPCStream();
  const table = tableFromIPC(ipc);
  return table.toArray().map((row) => row.toJSON());
}

function buildDataStore(): IfcDataStore {
  const strings = new StringTable();

  // Two walls; Wall2 will be deleted via the overlay.
  const entityBuilder = new EntityTableBuilder(2, strings);
  entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall1', '', '');
  entityBuilder.add(2, 'IFCWALL', 'wall-2-guid', 'Wall2 (deleted)', '', '');

  const propertyBuilder = new PropertyTableBuilder(strings);
  propertyBuilder.add({
    entityId: 1,
    psetName: 'Pset_WallCommon',
    psetGlobalId: '',
    propName: 'IsExternal',
    value: true,
    propType: PropertyValueType.Boolean,
  });
  propertyBuilder.add({
    entityId: 2,
    psetName: 'Pset_WallCommon',
    psetGlobalId: '',
    propName: 'IsExternal',
    value: false,
    propType: PropertyValueType.Boolean,
  });

  const relBuilder = new RelationshipGraphBuilder();
  relBuilder.addEdge(10, 1, RelationshipType.Contains, 100);
  relBuilder.addEdge(10, 2, RelationshipType.Contains, 101);

  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: 2,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    strings,
    entities: entityBuilder.build(),
    properties: propertyBuilder.build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: relBuilder.build(),
  } as unknown as IfcDataStore;
}

describe('ParquetExporter overlay deletions (#2046)', () => {
  it('omits an overlay-deleted entity from Entities.parquet', async () => {
    const dataStore = buildDataStore();
    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(2);

    const exporter = new ParquetExporter(dataStore, undefined, view);
    const bytes = await exporter.exportTable('entities');
    const rows = decodeParquet(bytes);

    const names = rows.map((r) => r.Name);
    expect(names).toContain('Wall1');
    expect(names).not.toContain('Wall2 (deleted)');
  });

  it('omits properties belonging to an overlay-deleted entity from Properties.parquet', async () => {
    const dataStore = buildDataStore();
    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(2);

    const exporter = new ParquetExporter(dataStore, undefined, view);
    const bytes = await exporter.exportTable('properties');
    const rows = decodeParquet(bytes);

    const entityIds = rows.map((r) => r.EntityId);
    expect(entityIds).toContain(1);
    expect(entityIds).not.toContain(2);
  });

  it('omits relationship edges touching an overlay-deleted entity from Relationships.parquet', async () => {
    const dataStore = buildDataStore();
    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(2);

    const exporter = new ParquetExporter(dataStore, undefined, view);
    const bytes = await exporter.exportTable('relationships');
    const rows = decodeParquet(bytes);

    const targetIds = rows.map((r) => r.TargetId);
    expect(targetIds).toContain(1);
    expect(targetIds).not.toContain(2);
  });

  it('reflects deletions made between two exports on the same instance', async () => {
    // The overlay index was memoised per instance and never invalidated, so a
    // second export replayed the first export's deletion set. `ParquetExporter`
    // has zero in-repo callers — every consumer is external, so "no caller does
    // that" is not a defence: construct once, export, edit, export again is an
    // ordinary external usage pattern and nothing in-repo constrains it.
    // (#2111 review)
    const dataStore = buildDataStore();
    const view = new LiveMutablePropertyView(null, 'm1');
    const exporter = new ParquetExporter(dataStore, undefined, view);

    // First export: nothing deleted yet, both walls present.
    const before = decodeParquet(await exporter.exportTable('entities')).map((r) => r.Name);
    expect(before).toContain('Wall1');
    expect(before).toContain('Wall2 (deleted)');

    // Delete through the SAME view the exporter holds, then export again.
    view.deleteEntity(2);
    const after = decodeParquet(await exporter.exportTable('entities')).map((r) => r.Name);

    expect(after).toContain('Wall1');
    expect(after).not.toContain('Wall2 (deleted)');
  });

  it('still exports everything when no mutation view is supplied (back-compat)', async () => {
    const dataStore = buildDataStore();
    const exporter = new ParquetExporter(dataStore);
    const bytes = await exporter.exportTable('entities');
    const rows = decodeParquet(bytes);

    const names = rows.map((r) => r.Name);
    expect(names).toContain('Wall1');
    expect(names).toContain('Wall2 (deleted)');
  });
});

/**
 * `buildDataStore` above leaves `entityIndex.byId` empty, which is fine for
 * the deletion tests (deletion only needs tombstone membership) but not for
 * a retype probe: `EffectiveEntityIndex.typeOf` resolves an existing (not
 * overlay-created) entity's ref via `CompleteEntityIndex.get`, which reads
 * `entityIndex.byId` — an empty map makes every id "not found" regardless of
 * what the overlay says. Populate it like `retype.test.ts` /
 * `reference-collector.test.ts` do.
 */
function buildDataStoreWithById(): IfcDataStore {
  const dataStore = buildDataStore();
  dataStore.entityIndex.byId.set(1, { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength: 0, lineNumber: 0 } as never);
  dataStore.entityIndex.byId.set(2, { expressId: 2, type: 'IFCWALL', byteOffset: 0, byteLength: 0, lineNumber: 0 } as never);
  return dataStore;
}

describe('ParquetExporter overlay retypes', () => {
  // StepExporter/Ifc5Exporter resolve `effective.typeOf(id)` before emitting
  // an entity's class (step-exporter.ts:961, `effectiveType = typeMut?.newType
  // ?? entity.type`), so a `setEntityType` retype changes what those two
  // exporters write. `writeEntities` here filters rows by `effective.isDeleted`
  // (the #2046 fix) but reads `Type` straight off `entities.typeEnum` — the
  // SOURCE class — never consulting the same `effective` index's `typeOf`.
  // A retyped-then-exported entity therefore lands in Entities.parquet under
  // its PRE-retype class, disagreeing with what StepExporter/Ifc5Exporter
  // would write for the identical overlay.
  it('reflects an overlay retype in the Type column, matching StepExporter/Ifc5Exporter', async () => {
    const dataStore = buildDataStoreWithById();
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setEntityType(1, 'IfcColumn', 'user');

    const exporter = new ParquetExporter(dataStore, undefined, view);
    const rows = decodeParquet(await exporter.exportTable('entities'));

    const wall1 = rows.find((r) => r.Name === 'Wall1');
    expect(wall1?.Type).toBe('IfcColumn');
  });

  // Guard on the fix itself. `effective.typeOf` answers for EVERY indexed
  // entity, not only retyped ones, and it answers UPPERCASE — so sourcing the
  // column from it unconditionally and re-deriving PascalCase through
  // IFC_ENTITY_NAMES silently changes UNTOUCHED rows whose type is missing
  // from that table. Four of the 125 enum types are: IfcProxy,
  // IfcSolidStratum, IfcVoidStratum, IfcWaterStratum. IfcProxy in particular
  // is common in real models, so this would corrupt the Type column of every
  // proxy row in any export that carried an overlay at all.
  it('leaves an untouched IfcProxy row PascalCase when an unrelated entity is retyped', async () => {
    const strings = new StringTable();
    const entityBuilder = new EntityTableBuilder(2, strings);
    entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall1', '', '');
    entityBuilder.add(2, 'IFCPROXY', 'proxy-1-guid', 'Proxy1', '', '');

    const dataStore = {
      ...buildDataStore(),
      entities: entityBuilder.build(),
      strings,
    } as IfcDataStore;
    dataStore.entityIndex.byId.set(1, { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength: 0, lineNumber: 0 } as never);
    dataStore.entityIndex.byId.set(2, { expressId: 2, type: 'IFCPROXY', byteOffset: 0, byteLength: 0, lineNumber: 0 } as never);

    // Retype a DIFFERENT entity, so the overlay exists and `effective` is
    // non-null, but the proxy row itself is untouched.
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setEntityType(1, 'IfcColumn', 'user');

    const exporter = new ParquetExporter(dataStore, undefined, view);
    const rows = decodeParquet(await exporter.exportTable('entities'));

    expect(rows.find((r) => r.Name === 'Proxy1')?.Type).toBe('IfcProxy');
    // Control: the retype still applies, so this is not passing because the
    // overlay was ignored wholesale.
    expect(rows.find((r) => r.Name === 'Wall1')?.Type).toBe('IfcColumn');
  });

  // Louis True's review of #2318: the retype branch resolves the overlay's
  // (always-UPPERCASE, see `EffectiveEntityIndex.effectiveType`) answer back
  // to PascalCase via `IFC_ENTITY_NAMES[effectiveType] ?? effectiveType` —
  // falling back to the raw uppercase string whenever the table has no entry.
  // `IfcProxy` is exactly one of the four names that WAS missing from that
  // table before #2319 (see the test above), so retyping an entity TO
  // `IfcProxy` exercises the same lookup this fallback depends on, from the
  // opposite direction: not "does an untouched IfcProxy row keep its case"
  // but "does a row retyped to IfcProxy gain the correct case". A future
  // regression that drops `IFCPROXY` from `IFC_ENTITY_NAMES` again would
  // silently degrade this row to `IFCPROXY` and only this test would catch
  // it in the retype path specifically.
  it('renders a row retyped to IfcProxy as PascalCase, not the raw uppercase enum key', async () => {
    const dataStore = buildDataStoreWithById();
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setEntityType(1, 'IfcProxy', 'user');

    const exporter = new ParquetExporter(dataStore, undefined, view);
    const rows = decodeParquet(await exporter.exportTable('entities'));

    const wall1 = rows.find((r) => r.Name === 'Wall1');
    expect(wall1?.Type).toBe('IfcProxy');
  });
});
