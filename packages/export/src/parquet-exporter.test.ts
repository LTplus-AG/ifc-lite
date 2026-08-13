/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { ParquetExporter } from './parquet-exporter.js';
import type { EntityRef, IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { MutablePropertyView as LiveMutablePropertyView } from '@ifc-lite/mutations';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  RelationshipGraphBuilder,
  QuantityTableBuilder,
  PropertyValueType,
  RelationshipType,
  QuantityType,
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

/**
 * `IfcDataStore.entityIndex.byId` is the read-only `EntityByIdIndex` surface
 * (a `Map` and the memory-optimised `CompactEntityIndex` both satisfy it), so
 * it has no `set`. These fixtures build a real `Map`, and some of them
 * populate it after the store is assembled — so keep the concrete `Map` type
 * on the fixture. Every `MockDataStore` is still an `IfcDataStore`.
 */
type MockDataStore = Omit<IfcDataStore, 'entityIndex'> & {
  entityIndex: { byId: Map<number, EntityRef>; byType: Map<string, number[]> };
};

function buildDataStore(): MockDataStore {
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
  relBuilder.addEdge(10, 1, RelationshipType.ContainsElements, 100);
  relBuilder.addEdge(10, 2, RelationshipType.ContainsElements, 101);

  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: 2,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: new Map<number, EntityRef>(), byType: new Map<string, number[]>() },
    strings,
    entities: entityBuilder.build(),
    properties: propertyBuilder.build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: relBuilder.build(),
  } as unknown as MockDataStore;
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

  it('omits quantities belonging to an overlay-deleted entity from Quantities.parquet', async () => {
    // writeQuantities computes its own `keep` from `effective.isDeleted`, same
    // shape as writeProperties above, but nothing previously exercised it —
    // an entity-level filter with zero coverage on this table specifically.
    const dataStore = buildDataStore();
    const quantityBuilder = new QuantityTableBuilder(dataStore.strings);
    quantityBuilder.add({
      entityId: 1,
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'NetSideArea',
      quantityType: QuantityType.Area,
      value: 10,
      formula: '',
    });
    quantityBuilder.add({
      entityId: 2,
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'NetSideArea',
      quantityType: QuantityType.Area,
      value: 20,
      formula: '',
    });
    dataStore.quantities = quantityBuilder.build();

    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(2);

    const exporter = new ParquetExporter(dataStore, undefined, view);
    const rows = decodeParquet(await exporter.exportTable('quantities'));

    const entityIds = rows.map((r) => r.EntityId);
    expect(entityIds).toContain(1);
    expect(entityIds).not.toContain(2);
  });
});

function mesh(partial: Partial<MeshData> & { expressId: number }): MeshData {
  return {
    positions: new Float32Array(),
    normals: new Float32Array(),
    indices: new Uint32Array(),
    color: [1, 1, 1, 1],
    ...partial,
  } as MeshData;
}

function geometry(meshes: MeshData[]): GeometryResult {
  const totalVertices = meshes.reduce((n, m) => n + m.positions.length / 3, 0);
  const totalTriangles = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  return {
    meshes,
    totalVertices,
    totalTriangles,
    coordinateInfo: {
      originShift: [0, 0, 0],
      originalBounds: { min: [0, 0, 0], max: [0, 0, 0] },
      shiftedBounds: { min: [0, 0, 0], max: [0, 0, 0] },
      hasLargeCoordinates: false,
    },
  } as unknown as GeometryResult;
}

describe('ParquetExporter overlay deletions reach the geometry tables', () => {
  // writeVertexBuffer/writeIndexBuffer/writeMeshes never called getEffective()
  // at all: Entities/Properties/Quantities/Relationships/SpatialHierarchy all
  // drop a tombstoned entity's rows, but VertexBuffer.parquet, IndexBuffer.parquet
  // and Meshes.parquet kept emitting its geometry unfiltered. The resulting
  // .bos archive is internally inconsistent — Meshes.ExpressId (and the
  // vertices/indices it points into) names an entity Entities.parquet no
  // longer has a row for.
  function buildStoreAndGeometry() {
    const dataStore = buildDataStore();
    const meshes: MeshData[] = [
      mesh({
        expressId: 1,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]),
      }),
      mesh({
        expressId: 2,
        positions: new Float32Array([5, 5, 5, 6, 5, 5, 6, 6, 5]),
        normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]),
      }),
    ];
    return { dataStore, geo: geometry(meshes) };
  }

  it('exports an express id above 2^31 without wrapping it negative', async () => {
    // IFC entity ids are bounded only by the `u32` every reader here uses -
    // `Uint32Array` in the parser's entity index, `u32` in the Rust crates - so
    // an id at or above 2_147_483_648 is reachable input. Arrow's content
    // inference reaches for Int32 on any whole number, which turned such an id
    // NEGATIVE: still id-shaped, joins to nothing, in a file that opens fine.
    const strings = new StringTable();
    const big = 3_000_000_000;
    const entityBuilder = new EntityTableBuilder(1, strings);
    entityBuilder.add(big, 'IFCWALL', 'wall-big-guid', 'Wall Big', '', '');
    const dataStore = {
      ...buildDataStore(),
      entities: entityBuilder.build(),
    } as MockDataStore;

    const rows = decodeParquet(await new ParquetExporter(dataStore).exportTable('entities'));
    expect(rows.map((r) => Number(r.ExpressId))).toEqual([big]);
  });

  it('omits a deleted entity from Meshes.parquet', async () => {
    const { dataStore, geo } = buildStoreAndGeometry();
    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(2);

    const exporter = new ParquetExporter(dataStore, geo, view);
    const entityIds = decodeParquet(await exporter.exportTable('entities')).map((r) => r.ExpressId);
    const meshIds = decodeParquet(await exporter.exportTable('meshes')).map((r) => r.ExpressId);

    expect(entityIds).toEqual([1]);
    // Every id Meshes.parquet names must have a row in Entities.parquet.
    expect(meshIds.every((id) => entityIds.includes(id))).toBe(true);
  });

  it('drops the deleted entity\'s vertices from VertexBuffer.parquet', async () => {
    const { dataStore, geo } = buildStoreAndGeometry();
    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(2);

    const exporter = new ParquetExporter(dataStore, geo, view);
    const vertexRows = decodeParquet(await exporter.exportTable('vertices'));

    // Mesh 2's vertices are all at X=5/6 — surviving mesh 1 only touches X=0/1.
    expect(vertexRows.some((r) => Number(r.X) >= 5)).toBe(false);
    expect(vertexRows).toHaveLength(3);
  });

  it('drops the deleted entity\'s triangles from IndexBuffer.parquet', async () => {
    const { dataStore, geo } = buildStoreAndGeometry();
    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(2);

    const exporter = new ParquetExporter(dataStore, geo, view);
    const indexRows = decodeParquet(await exporter.exportTable('indices'));

    expect(indexRows).toHaveLength(1);
  });

  it('still exports all geometry when no mutation view is supplied (back-compat)', async () => {
    const { dataStore, geo } = buildStoreAndGeometry();
    const exporter = new ParquetExporter(dataStore, geo);

    const meshIds = decodeParquet(await exporter.exportTable('meshes')).map((r) => r.ExpressId);
    expect(meshIds).toEqual([1, 2]);
  });

  /**
   * Deleting the LAST mesh cannot expose a misaligned offset — nothing
   * follows it. The regression this fix is exposed to is a mesh dropped in
   * the MIDDLE: `writeMeshes` reports the `VertexStart`/`IndexStart` that
   * `writeVertexBuffer`/`writeIndexBuffer` accumulate, so if the three
   * loops ever stop skipping the same set, every later mesh points at
   * another mesh's vertices. That reads as geometry silently attached to
   * the wrong element, which no count would reveal.
   *
   * Three meshes, delete the middle one, and assert the survivor's start
   * offsets closed the gap rather than preserving it.
   */
  it('keeps VertexStart/IndexStart aligned when a MIDDLE mesh is deleted', async () => {
    const dataStore = buildDataStore();
    const meshes: MeshData[] = [
      mesh({
        expressId: 1,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]),
      }),
      mesh({
        expressId: 2,
        positions: new Float32Array([5, 5, 5, 6, 5, 5, 6, 6, 5]),
        normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]),
      }),
      mesh({
        expressId: 3,
        positions: new Float32Array([9, 9, 9, 8, 9, 9, 8, 8, 9]),
        normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]),
      }),
    ];
    const geo = geometry(meshes);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.deleteEntity(2);

    const exporter = new ParquetExporter(dataStore, geo, view);
    const meshRows = decodeParquet(await exporter.exportTable('meshes'));
    const vertexRows = decodeParquet(await exporter.exportTable('vertices'));

    expect(meshRows.map((r) => r.ExpressId)).toEqual([1, 3]);
    // Mesh 3 must start immediately after mesh 1's three vertices — NOT at 6,
    // which is where it would sit if the deleted mesh's span were still
    // counted.
    expect(Number(meshRows[1].VertexStart)).toBe(3);
    expect(Number(meshRows[1].IndexStart)).toBe(3);
    expect(vertexRows).toHaveLength(6);
    // And the offset must actually land on mesh 3's own data (X = 9), not
    // mesh 2's (X = 5) — an aligned-looking number pointing at the wrong
    // vertices is the failure this guards.
    expect(Number(vertexRows[Number(meshRows[1].VertexStart)].X)).toBe(9);
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
function buildDataStoreWithById(): MockDataStore {
  const dataStore = buildDataStore();
  dataStore.entityIndex.byId.set(1, { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength: 0, lineNumber: 0 });
  dataStore.entityIndex.byId.set(2, { expressId: 2, type: 'IFCWALL', byteOffset: 0, byteLength: 0, lineNumber: 0 });
  return dataStore;
}

describe('ParquetExporter overlay retypes', () => {
  // StepExporter/Ifc5Exporter resolve `effective.typeOf(id)` before emitting
  // an entity's class (step-exporter.ts:961, `effectiveType = typeMut?.newType
  // ?? entity.type`), so a `setEntityType` retype changes what those two
  // exporters write. `writeEntities` filters rows by `effective.isDeleted`
  // (the #2046 fix); before this fix it still read `Type` straight off
  // `entities.typeEnum` — the SOURCE class — never consulting the same
  // `effective` index's `typeOf`, so a retyped-then-exported entity landed
  // in Entities.parquet under its PRE-retype class, disagreeing with what
  // StepExporter/Ifc5Exporter wrote for the identical overlay. This test
  // guards against that regression.
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
    } satisfies MockDataStore;
    dataStore.entityIndex.byId.set(1, { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength: 0, lineNumber: 0 });
    dataStore.entityIndex.byId.set(2, { expressId: 2, type: 'IFCPROXY', byteOffset: 0, byteLength: 0, lineNumber: 0 });

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

  // CodeRabbit review of #2318 (Major) asked for this fallback to be pinned
  // "with an unrelated overlay retype" present. That construction turns out
  // not to discriminate: `effective.typeOf` answers uppercase for EVERY
  // indexed entity as soon as ANY `MutablePropertyView` is attached (even
  // with zero mutations — `getEffectiveEntityIndex`'s `sourceOnly` index
  // still answers `base.get(id)?.type.toUpperCase()`), and the override
  // branch's `IFC_ENTITY_NAMES[effectiveType] ?? effectiveType` falls back to
  // that same raw uppercase string whenever the table misses. So an
  // untouched out-of-enum row lands on the same raw name whether `source`
  // itself is the correct `getTypeName` answer or the pre-fix
  // `IfcTypeEnumToString` literal 'Unknown' — verified by mutating
  // `parquet-exporter.ts` back to `IfcTypeEnumToString(entities.typeEnum[idx])`
  // and re-running an overlay-attached version of this test: still 9/9 green,
  // because `source.toUpperCase() = 'UNKNOWN'` disagrees with
  // `effectiveType = 'IFCSOMEUNKNOWN'`, so it takes the override branch and
  // recovers the raw name from `?? effectiveType` regardless of what `source`
  // was. The literal-'Unknown' regression is reachable only when NO overlay
  // is attached at all: `getEffective()` returns `null` (not merely an
  // unmutated overlay), `effectiveType` is `undefined`, and the ternary's
  // first arm returns `source` unmodified — the one path where `source`'s own
  // correctness is what's on the line. This test targets that path.
  //
  // `entities.getTypeName(id)` (entity-table.ts) falls back to the raw parsed
  // type name for a type outside the generated enum; `IfcTypeEnumToString`
  // alone collapses it to the literal string 'Unknown' (entity-table.test.ts's
  // 'returns the rawTypeName fallback for unknown enum types' pins the same
  // fallback one layer down).
  it('renders an out-of-enum row on its raw parsed type name, not "Unknown", when exported with no overlay at all', async () => {
    const strings = new StringTable();
    const entityBuilder = new EntityTableBuilder(1, strings);
    entityBuilder.add(1, 'IFCSOMEUNKNOWN', 'unknown-1-guid', 'Unknown1', '', '');

    const dataStore = {
      ...buildDataStore(),
      entities: entityBuilder.build(),
      strings,
    } as IfcDataStore;

    // No `mutationView` argument at all: `getEffective()` returns `null`, so
    // `effectiveType` is `undefined` and the ternary's first arm — the one
    // that returns `source` as-is — is what's under test.
    const exporter = new ParquetExporter(dataStore);
    const rows = decodeParquet(await exporter.exportTable('entities'));

    const unknownType = rows.find((r) => r.Name === 'Unknown1')?.Type;
    expect(unknownType).not.toBe('Unknown');
    expect((unknownType as string).toLowerCase()).toContain('someunknown');
  });
});
