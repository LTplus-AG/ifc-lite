/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ParquetExporter`'s geometry tables (`VertexBuffer` / `IndexBuffer` /
 * `Meshes`), its column typing, and the metadata block had NO test at all —
 * `parquet-exporter.test.ts` pins the overlay-deletion behaviour and nothing
 * else. A mutation sweep confirmed it: dropping the per-mesh origin fold,
 * swapping the Y and Z vertex columns, emitting `VertexCount` un-divided by 3,
 * freezing `IndexStart` at 0, swapping `Index1`/`Index2`, and disabling the
 * Float64 forcing for declared-REAL columns ALL left the suite green.
 *
 * Every one of those is a silently-wrong `.bos` archive: it opens fine and the
 * numbers inside are wrong, which is exactly the failure another vendor's tool
 * discovers days later. This file pins the writers row by row.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ParquetExporter } from './parquet-exporter.js';
import JSZip from 'jszip';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
  PropertyValueType,
  QuantityType,
} from '@ifc-lite/data';

/**
 * Both packages ship their own types, so the read side (`tableFromIPC` /
 * `readParquet`) is reached through a plain dynamic import. The import must
 * stay dynamic: `parquet-wasm`'s Node build compiles its WebAssembly module
 * as an import side effect, and `beforeAll` below pays that cost once,
 * outside any single test's timing budget (see the note on that hook).
 */
async function readArrowTable(bytes: Uint8Array) {
  const { readParquet } = await import('parquet-wasm');
  const { tableFromIPC } = await import('apache-arrow');
  return tableFromIPC(readParquet(bytes).intoIPCStream());
}

/** Decode a Parquet buffer back to plain row objects for assertions. */
async function decodeParquet(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  return (await readArrowTable(bytes)).toArray().map((row) => row.toJSON());
}

/** Decode a Parquet buffer and report its Arrow schema field types by name. */
async function decodeParquetSchema(bytes: Uint8Array): Promise<Record<string, string>> {
  const table = await readArrowTable(bytes);
  const out: Record<string, string> = {};
  for (const field of table.schema.fields) out[field.name] = String(field.type);
  return out;
}

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

/**
 * Store with ONE quantity and ONE property whose REAL value is a whole number.
 * Whole-number reals are the case that exposes the Float64 forcing: content
 * inference alone would type the column Int32 and the consumer would read an
 * integer schema for a `IfcQuantityArea` value.
 */
function buildTypedStore(): IfcDataStore {
  const strings = new StringTable();

  // Flags deliberately ASYMMETRIC across the two rows: an entity that has
  // geometry and is not a type, and an entity that is a type and has no
  // geometry. Two rows agreeing on both flags cannot tell HAS_GEOMETRY from
  // IS_TYPE — a swapped mask would read identically.
  const entityBuilder = new EntityTableBuilder(2, strings);
  entityBuilder.add(1, 'IFCWALL', 'wall-1-guid', 'Wall1', '', '', true, false);
  entityBuilder.add(2, 'IFCWALLTYPE', 'wall-type-guid', 'WallTypeA', '', '', false, true);

  const propertyBuilder = new PropertyTableBuilder(strings);
  propertyBuilder.add({
    entityId: 1,
    psetName: 'Pset_WallCommon',
    psetGlobalId: '',
    propName: 'ThermalTransmittance',
    value: 3, // a whole-number REAL
    propType: PropertyValueType.Real,
  });

  const quantityBuilder = new QuantityTableBuilder(strings);
  quantityBuilder.add({
    entityId: 1,
    qsetName: 'Qto_WallBaseQuantities',
    quantityName: 'NetSideArea',
    quantityType: QuantityType.Area,
    value: 1200, // a whole-number REAL, and > 2^31 is the wrap risk
    formula: '',
  });

  return {
    fileSize: 123,
    schemaVersion: 'IFC4',
    entityCount: 2,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    strings,
    entities: entityBuilder.build(),
    properties: propertyBuilder.build(),
    quantities: quantityBuilder.build(),
    relationships: new RelationshipGraphBuilder().build(),
  } as unknown as IfcDataStore;
}

/**
 * `toParquet()` (and this file's own `readArrowTable`) dynamically import
 * `apache-arrow` and `parquet-wasm` on first use. `parquet-wasm`'s Node
 * build instantiates its WebAssembly module synchronously as an import side
 * effect (`node_modules/parquet-wasm/node/parquet_wasm.js`: `readFileSync` +
 * `new WebAssembly.Instance(...)` at module scope), so the first call in
 * this worker pays real module-resolution + WASM-compile latency — under
 * light load, comfortably inside vitest's 5s default `testTimeout`; under
 * CI-scale contention (many packages' test suites racing for CPU in the
 * same `turbo test` run), it can push PAST it (#2248 — reproduced as
 * `Error: Test timed out in 5000ms` on whichever test happened to run
 * first, 3/6 concurrent local runs, plus one CI run at 5025ms with the very
 * next test at 4974ms — one tick from also timing out).
 *
 * That is a fixed one-time tax that has nothing to do with any single
 * test's assertions, so it does not belong inside any single test's
 * timing budget. Pay it once here, in a hook with its own (generous, and
 * import-latency-appropriate) timeout, so every `it()` below — including
 * whichever one the test runner happens to schedule first — starts from a
 * warm module cache and reflects only its own (fast) work.
 */
beforeAll(async () => {
  await import('apache-arrow');
  await import('parquet-wasm');
  // The `exportBOS` tests below also reach for jszip from inside their own
  // bodies to read the archive back. That import is cheap today only because
  // `ParquetExporter.exportBOS` itself lazily imports jszip, so the module is
  // already resolved by the time the test asks for it — an incidental ordering
  // the tests should not silently depend on. Warm it explicitly so it stays
  // outside their budgets even if the exporter stops loading it first.
  await import('jszip');
}, 30_000);

describe('ParquetExporter VertexBuffer.parquet', () => {
  it('bakes the per-mesh origin into world vertices on all three axes', async () => {
    // The BOS columnar layout has no transform column, so the ONLY place the
    // origin can be applied is here. A fixture at origin (0,0,0) makes the fold
    // an identity and cannot see this — every component is deliberately
    // non-zero AND distinct so a fold dropped on any single axis shows up.
    const m = mesh({
      expressId: 1,
      positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([0, 0, 1]),
      origin: [10, 20, 30],
    } as Partial<MeshData> & { expressId: number });

    const exporter = new ParquetExporter({} as IfcDataStore, geometry([m]));
    const rows = await decodeParquet(await exporter.exportTable('vertices'));

    expect(rows).toHaveLength(1);
    expect(rows[0].X).toBeCloseTo(11, 5);
    expect(rows[0].Y).toBeCloseTo(22, 5);
    expect(rows[0].Z).toBeCloseTo(33, 5);
  });

  it('leaves normals origin-invariant', async () => {
    const m = mesh({
      expressId: 1,
      positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([0.25, 0.5, 0.75]),
      origin: [10, 20, 30],
    } as Partial<MeshData> & { expressId: number });

    const exporter = new ParquetExporter({} as IfcDataStore, geometry([m]));
    const rows = await decodeParquet(await exporter.exportTable('vertices'));

    expect(rows[0].NormalX).toBeCloseTo(0.25, 5);
    expect(rows[0].NormalY).toBeCloseTo(0.5, 5);
    expect(rows[0].NormalZ).toBeCloseTo(0.75, 5);
  });

  it('keeps the X/Y/Z column split in axis order for a mesh with no origin', async () => {
    // The no-origin branch is the OTHER side of the fold and is reached by a
    // separate `push(...)` — it must produce the same column assignment.
    const m = mesh({
      expressId: 1,
      positions: new Float32Array([4, 5, 6, 7, 8, 9]),
      normals: new Float32Array([0, 0, 1, 0, 1, 0]),
    });

    const exporter = new ParquetExporter({} as IfcDataStore, geometry([m]));
    const rows = await decodeParquet(await exporter.exportTable('vertices'));

    expect(rows.map((r) => [r.X, r.Y, r.Z])).toEqual([
      [4, 5, 6],
      [7, 8, 9],
    ]);
  });

  it('treats an explicit zero origin exactly like an absent one', async () => {
    const zero = mesh({
      expressId: 1,
      positions: new Float32Array([4, 5, 6]),
      normals: new Float32Array([0, 0, 1]),
      origin: [0, 0, 0],
    } as Partial<MeshData> & { expressId: number });
    const absent = mesh({
      expressId: 2,
      positions: new Float32Array([4, 5, 6]),
      normals: new Float32Array([0, 0, 1]),
    });

    const a = await decodeParquet(
      await new ParquetExporter({} as IfcDataStore, geometry([zero])).exportTable('vertices'),
    );
    const b = await decodeParquet(
      await new ParquetExporter({} as IfcDataStore, geometry([absent])).exportTable('vertices'),
    );
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ X: 4, Y: 5, Z: 6 });
  });
});

describe('ParquetExporter IndexBuffer.parquet', () => {
  it('splits the flat index stream into Index0/1/2 in the order it was given', async () => {
    // Faithful copy, not a winding claim: `MeshData.indices` winding is
    // documented as unreliable, but the exporter must not permute the corners
    // it was handed — a consumer joining IndexBuffer to VertexBuffer would
    // build different triangles.
    const m = mesh({
      expressId: 1,
      positions: new Float32Array(18),
      normals: new Float32Array(18),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    });

    const exporter = new ParquetExporter({} as IfcDataStore, geometry([m]));
    const rows = await decodeParquet(await exporter.exportTable('indices'));

    expect(rows).toEqual([
      { Index0: 0, Index1: 1, Index2: 2 },
      { Index0: 3, Index1: 4, Index2: 5 },
    ]);
  });
});

describe('ParquetExporter Meshes.parquet', () => {
  it('emits vertex/index starts that accumulate across meshes, and counts in the right unit', async () => {
    // TWO meshes with DIFFERENT sizes: a single mesh leaves every start at 0
    // and cannot see a frozen accumulator, and equal sizes cannot tell a
    // vertex stride from an index stride.
    const a = mesh({
      expressId: 11,
      positions: new Float32Array(3 * 4), // 4 vertices
      normals: new Float32Array(3 * 4),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]), // 6 indices
    });
    const b = mesh({
      expressId: 22,
      positions: new Float32Array(3 * 3), // 3 vertices
      normals: new Float32Array(3 * 3),
      indices: new Uint32Array([0, 1, 2]), // 3 indices
    });

    const exporter = new ParquetExporter({} as IfcDataStore, geometry([a, b]));
    const rows = await decodeParquet(await exporter.exportTable('meshes'));

    expect(rows).toEqual([
      { ExpressId: 11, VertexStart: 0, VertexCount: 4, IndexStart: 0, IndexCount: 6 },
      { ExpressId: 22, VertexStart: 4, VertexCount: 3, IndexStart: 6, IndexCount: 3 },
    ]);
  });

  it('has starts that index the VertexBuffer/IndexBuffer rows the same export wrote', async () => {
    // The three geometry tables are only usable TOGETHER; this pins the join.
    const a = mesh({
      expressId: 11,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
    });
    const b = mesh({
      expressId: 22,
      positions: new Float32Array([5, 5, 5, 6, 5, 5, 6, 6, 5, 5, 6, 5]),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });

    const exporter = new ParquetExporter({} as IfcDataStore, geometry([a, b]));
    const meshRows = await decodeParquet(await exporter.exportTable('meshes'));
    const vertexRows = await decodeParquet(await exporter.exportTable('vertices'));
    const indexRows = await decodeParquet(await exporter.exportTable('indices'));

    const second = meshRows[1];
    expect(vertexRows).toHaveLength(3 + 4);
    // VertexStart must land on mesh b's FIRST vertex, not mesh a's.
    expect(vertexRows[Number(second.VertexStart)]).toMatchObject({ X: 5, Y: 5, Z: 5 });
    // IndexStart is in indices, so it maps to triangle IndexStart/3.
    expect(Number(second.IndexStart) % 3).toBe(0);
    expect(indexRows).toHaveLength((3 + 6) / 3);
    expect(Number(second.IndexStart) / 3).toBe(1);
  });

  it('writes no rows for an empty mesh set', async () => {
    const exporter = new ParquetExporter({} as IfcDataStore, geometry([]));
    expect(await decodeParquet(await exporter.exportTable('meshes'))).toEqual([]);
    expect(await decodeParquet(await exporter.exportTable('vertices'))).toEqual([]);
    expect(await decodeParquet(await exporter.exportTable('indices'))).toEqual([]);
  });
});

describe('ParquetExporter column typing', () => {
  it('keeps a whole-number REAL property value in a Float64 column', async () => {
    const exporter = new ParquetExporter(buildTypedStore());
    const bytes = await exporter.exportTable('properties');
    expect((await decodeParquetSchema(bytes)).ValueReal).toMatch(/Float(64)?/i);
    expect((await decodeParquet(bytes))[0].ValueReal).toBe(3);
  });

  it('keeps a whole-number quantity value in a Float64 column', async () => {
    const exporter = new ParquetExporter(buildTypedStore());
    const bytes = await exporter.exportTable('quantities');
    expect((await decodeParquetSchema(bytes)).Value).toMatch(/Float(64)?/i);
    expect((await decodeParquet(bytes))[0].Value).toBe(1200);
  });

  it('leaves an undeclared integer column as an integer (the forcing is opt-in, not blanket)', async () => {
    // Counter-example: without this, "declare every numeric column Float64"
    // would pass the two assertions above just as well.
    const exporter = new ParquetExporter(buildTypedStore());
    const schema = await decodeParquetSchema(await exporter.exportTable('entities'));
    expect(schema.ExpressId).toMatch(/Int/i);
  });
});

describe('ParquetExporter Entities.parquet flag columns', () => {
  it('reads HasGeometry and IsType from their own flag bits', async () => {
    const rows = await decodeParquet(await new ParquetExporter(buildTypedStore()).exportTable('entities'));
    expect(rows.map((r) => [r.ExpressId, r.HasGeometry, r.IsType])).toEqual([
      [1, true, false],
      [2, false, true],
    ]);
  });
});

describe('ParquetExporter Properties.parquet', () => {
  it('reports ValueBool as null for a non-boolean property (the 255 sentinel)', async () => {
    // The stored sentinel is 255, which is neither 1 nor 0 — without the
    // sentinel check every non-boolean property row would export `false`,
    // i.e. a real value the source never carried.
    const rows = await decodeParquet(await new ParquetExporter(buildTypedStore()).exportTable('properties'));
    expect(rows[0].PropType).toBe('Real');
    expect(rows[0].ValueBool).toBeNull();
  });
});

describe('ParquetExporter Quantities.parquet', () => {
  it('reports a quantity with no formula as null rather than string index 0', async () => {
    const rows = await decodeParquet(await new ParquetExporter(buildTypedStore()).exportTable('quantities'));
    expect(rows[0].Formula).toBeNull();
  });
});

describe('ParquetExporter Metadata.json', () => {
  it('reports the geometry statistics of the export it accompanies', async () => {
    const a = mesh({
      expressId: 11,
      positions: new Float32Array(3 * 4),
      normals: new Float32Array(3 * 4),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const exporter = new ParquetExporter(buildTypedStore(), geometry([a]));
    const zipBytes = await exporter.exportBOS();

    const zip = await JSZip.loadAsync(zipBytes);
    const metadata = JSON.parse(await zip.file('Metadata.json')!.async('string'));

    expect(metadata.statistics.meshCount).toBe(1);
    expect(metadata.statistics.vertexCount).toBe(4);
    expect(metadata.statistics.triangleCount).toBe(2);
    expect(metadata.sourceFile).toMatchObject({ size: 123, schema: 'IFC4', entityCount: 2 });
  });

  it('reports zeroed geometry statistics when no geometry was supplied', async () => {
    // The two-valued signal in both directions: the branch above must not be
    // passing merely because the numbers happen to be non-zero.
    const zipBytes = await new ParquetExporter(buildTypedStore()).exportBOS();
    const zip = await JSZip.loadAsync(zipBytes);
    const metadata = JSON.parse(await zip.file('Metadata.json')!.async('string'));

    expect(metadata.statistics.meshCount).toBe(0);
    expect(metadata.statistics.vertexCount).toBe(0);
    expect(metadata.statistics.triangleCount).toBe(0);
    expect(zip.file('VertexBuffer.parquet')).toBeNull();
  });
});
