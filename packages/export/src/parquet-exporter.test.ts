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
