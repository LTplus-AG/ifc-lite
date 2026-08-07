// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `decodeDataModel` bounds-checking contract.
 *
 * Every length-prefixed section in the wire format (the five top-level
 * required sections, the five nested spatial-hierarchy sub-sections, and the
 * three optional appended tables) is `[u32 len][len bytes]`. Only the
 * optional-section reader used to validate that prefix; a truncated
 * *required* section instead surfaced a raw `RangeError` from
 * `DataView.getUint32` / the `Uint8Array` constructor, deep inside
 * `decodeDataModel` / `parseLookupTable`, instead of this module's own
 * `Malformed data model: ...` error. These tests pin the fix: every
 * length-prefixed read now throws the same clear, message-bearing error on
 * truncation, and a well-formed buffer — including one with legitimately
 * empty (zero-row) required tables — still decodes real content end-to-end.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { decodeDataModel } from './data-model-decoder.js';

// apache-arrow's browser export map hides the `.d.ts` from TS5's strict
// resolver, same as data-model-decoder.ts itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let arrow: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let parquet: any;

beforeAll(async () => {
  // `decodeDataModel` boots parquet-wasm via `ensureParquetInit()`, which
  // fetches the .wasm asset by URL — a Vite/browser-only path that has no
  // static server under plain `vitest run`. `initSync` with the wasm file's
  // own bytes initializes the SAME cached module instance (parquet-wasm
  // memoizes on its internal `wasm` binding, see arrow2.js's `__wbg_init`),
  // so `ensureParquetInit()`'s later `parquet.default(url)` call short-
  // circuits on the existing instance instead of re-fetching.
  const require = createRequire(import.meta.url);
  const jsPath = require.resolve('parquet-wasm/esm/arrow2.js');
  const wasmPath = jsPath.replace(/arrow2\.js$/, 'arrow2_bg.wasm');
  const wasmBytes = readFileSync(wasmPath);
  parquet = await import('parquet-wasm/esm/arrow2.js');
  parquet.initSync(wasmBytes);

  arrow = await import('apache-arrow');
});

/** Serialize an Arrow-JS Table to Parquet bytes via parquet-wasm, mirroring
 *  the server's writer path (packages/export/src/parquet-exporter.ts). */
function toParquetBytes(table: unknown): Uint8Array {
  const ipc = arrow.tableToIPC(table, 'stream');
  const wasmTable = parquet.Table.fromIPCStream(ipc);
  return new Uint8Array(parquet.writeParquet(wasmTable));
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function concat(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

/** Wrap Parquet bytes with their u32-LE length prefix, as the wire format
 *  requires for every section. */
function section(bytes: Uint8Array): Uint8Array[] {
  return [u32le(bytes.length), bytes];
}

function entitiesTable(rows: { id: number; type: string; globalId: string; name: string }[]) {
  return new arrow.Table({
    entity_id: arrow.vectorFromArray(rows.map((r) => r.id), new arrow.Uint32()),
    type_name: arrow.vectorFromArray(rows.map((r) => r.type), new arrow.Utf8()),
    global_id: arrow.vectorFromArray(rows.map((r) => r.globalId), new arrow.Utf8()),
    name: arrow.vectorFromArray(rows.map((r) => r.name), new arrow.Utf8()),
    has_geometry: arrow.vectorFromArray(
      rows.map(() => 1),
      new arrow.Uint8()
    ),
  });
}

function emptyPropertiesTable() {
  return new arrow.Table({
    pset_id: arrow.vectorFromArray([], new arrow.Uint32()),
    pset_name: arrow.vectorFromArray([], new arrow.Utf8()),
    property_name: arrow.vectorFromArray([], new arrow.Utf8()),
    property_value: arrow.vectorFromArray([], new arrow.Utf8()),
    property_type: arrow.vectorFromArray([], new arrow.Utf8()),
  });
}

function emptyQuantitiesTable() {
  return new arrow.Table({
    qset_id: arrow.vectorFromArray([], new arrow.Uint32()),
    qset_name: arrow.vectorFromArray([], new arrow.Utf8()),
    method_of_measurement: arrow.vectorFromArray([], new arrow.Utf8()),
    quantity_name: arrow.vectorFromArray([], new arrow.Utf8()),
    quantity_value: arrow.vectorFromArray([], new arrow.Float64()),
    quantity_type: arrow.vectorFromArray([], new arrow.Utf8()),
  });
}

function relationshipsTable(rows: { relType: string; relatingId: number; relatedId: number }[]) {
  return new arrow.Table({
    rel_type: arrow.vectorFromArray(rows.map((r) => r.relType), new arrow.Utf8()),
    relating_id: arrow.vectorFromArray(rows.map((r) => r.relatingId), new arrow.Uint32()),
    related_id: arrow.vectorFromArray(rows.map((r) => r.relatedId), new arrow.Uint32()),
  });
}

function spatialNodesTable(rows: { id: number; parentId: number; level: number; path: string; type: string }[]) {
  const listType = new arrow.List(arrow.Field.new('item', new arrow.Uint32(), true));
  return new arrow.Table({
    entity_id: arrow.vectorFromArray(rows.map((r) => r.id), new arrow.Uint32()),
    parent_id: arrow.vectorFromArray(rows.map((r) => r.parentId), new arrow.Uint32()),
    level: arrow.vectorFromArray(rows.map((r) => r.level), new arrow.Uint16()),
    path: arrow.vectorFromArray(rows.map((r) => r.path), new arrow.Utf8()),
    type_name: arrow.vectorFromArray(rows.map((r) => r.type), new arrow.Utf8()),
    name: arrow.vectorFromArray(
      rows.map(() => null),
      new arrow.Utf8()
    ),
    elevation: arrow.vectorFromArray(
      rows.map(() => null),
      new arrow.Float64()
    ),
    children_ids: arrow.vectorFromArray(
      rows.map(() => []),
      listType
    ),
    element_ids: arrow.vectorFromArray(
      rows.map(() => []),
      listType
    ),
  });
}

function emptyLookupTable() {
  return new arrow.Table({
    element_id: arrow.vectorFromArray([], new arrow.Uint32()),
    spatial_id: arrow.vectorFromArray([], new arrow.Uint32()),
  });
}

/**
 * Build a complete, well-formed `decodeDataModel` wire buffer.
 *
 * `emptyQuantities` / `emptyRelationships` let a caller exercise the
 * legitimate zero-ROW case for a required table (an IFC model can genuinely
 * have no quantities or no relationships) while keeping the section's BYTE
 * length non-zero, as every real Parquet-encoded table is.
 */
function buildDataModelBuffer(
  opts: { emptyQuantities?: boolean; emptyRelationships?: boolean } = {}
): ArrayBuffer {
  const entities = toParquetBytes(
    entitiesTable([{ id: 1, type: 'IfcWall', globalId: 'GUID-1', name: 'Wall 1' }])
  );
  const properties = toParquetBytes(emptyPropertiesTable());
  const quantities = toParquetBytes(emptyQuantitiesTable());
  const relationships = toParquetBytes(
    opts.emptyRelationships
      ? relationshipsTable([])
      : relationshipsTable([{ relType: 'IfcRelAggregates', relatingId: 1, relatedId: 2 }])
  );

  const nodes = toParquetBytes(
    spatialNodesTable([{ id: 1, parentId: 0, level: 0, path: '/1', type: 'IfcProject' }])
  );
  const lookup = toParquetBytes(emptyLookupTable());

  const spatialChunks: Uint8Array[] = [
    ...section(nodes),
    ...section(lookup), // element_to_storey
    ...section(lookup), // element_to_building
    ...section(lookup), // element_to_site
    ...section(lookup), // element_to_space
    u32le(42), // project_id
  ];
  const spatialTotal = spatialChunks.reduce((n, c) => n + c.length, 0);
  const spatialBytes = new Uint8Array(spatialTotal);
  {
    let o = 0;
    for (const c of spatialChunks) {
      spatialBytes.set(c, o);
      o += c.length;
    }
  }

  return concat([
    ...section(entities),
    ...section(properties),
    ...section(opts.emptyQuantities ? quantities : toParquetBytes(emptyQuantitiesTable())),
    ...section(relationships),
    ...section(spatialBytes),
    // No optional classification/material/document sections appended —
    // exercises the "older payload" path (readOptionalSection returns null).
  ]);
}

describe('decodeDataModel — required-section truncation (RED: native RangeError -> GREEN: clear Malformed error)', () => {
  it('throws the clear message, not a native error, when a top-level required section is truncated', async () => {
    const full = buildDataModelBuffer();
    // Truncate mid-way through the entities Parquet payload: the u32 prefix
    // at offset 0 claims more bytes than actually follow.
    const truncated = full.slice(0, 4 + 10);

    await expect(decodeDataModel(truncated)).rejects.toThrow(/^Malformed data model: truncated entities section/);
  });

  it('throws the clear message when the relationships section length prefix itself is missing', async () => {
    const full = buildDataModelBuffer();
    const view = new DataView(full);
    let offset = 0;
    // Walk past entities, properties, quantities (skip their data too) to
    // land exactly at the relationships length prefix, then cut the buffer
    // there — fewer than 4 bytes remain for that prefix.
    for (let i = 0; i < 3; i++) {
      const len = view.getUint32(offset, true);
      offset += 4 + len;
    }
    const truncated = full.slice(0, offset + 2); // 2 of 4 prefix bytes remain

    await expect(decodeDataModel(truncated)).rejects.toThrow(
      /^Malformed data model: truncated relationships section length prefix/
    );
  });

  it('throws the clear message when a nested spatial sub-section (element-to-storey lookup) is truncated', async () => {
    const full = buildDataModelBuffer();
    const view = new DataView(full);
    let offset = 0;
    // Walk past entities, properties, quantities, relationships to the
    // spatial section, then into it past the nodes sub-section, to land at
    // the element-to-storey lookup's length prefix.
    for (let i = 0; i < 4; i++) {
      const len = view.getUint32(offset, true);
      offset += 4 + len;
    }
    const spatialSectionStart = offset;
    const spatialLen = view.getUint32(spatialSectionStart, true);
    const spatialDataStart = spatialSectionStart + 4;
    const nodesLen = view.getUint32(spatialDataStart, true);
    const storeyLookupPrefixOffset = spatialDataStart + 4 + nodesLen;
    expect(spatialLen).toBeGreaterThan(0); // sanity: we did land inside real data

    // Corrupt ONLY the element-to-storey lookup's own nested length prefix
    // to claim far more bytes than actually follow it, while leaving the
    // outer buffer length (and the outer "spatial" section's own prefix)
    // untouched. This isolates truncation to the NESTED sub-section — the
    // outer spatial-section read must still succeed; only the inner
    // element-to-storey read should fail.
    const corrupted = full.slice(0);
    new DataView(corrupted).setUint32(storeyLookupPrefixOffset, 999_999_999, true);

    await expect(decodeDataModel(corrupted)).rejects.toThrow(
      /^Malformed data model: truncated element-to-storey lookup section/
    );
  });

  it('RED baseline note: a native error class would also satisfy assert.throws() — asserting the exact message is what distinguishes the fix', async () => {
    const full = buildDataModelBuffer();
    const truncated = full.slice(0, 4 + 10);
    let caught: unknown;
    try {
      await decodeDataModel(truncated);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/^Malformed data model:/);
    expect((caught as Error).message).not.toMatch(/outside the bounds|Invalid typed array length/);
  });
});

describe('decodeDataModel — bounding controls (well-formed buffers still decode real content)', () => {
  it('decodes a well-formed buffer end-to-end: entities, relationships, and spatial hierarchy round-trip', async () => {
    const buf = buildDataModelBuffer();
    const model = await decodeDataModel(buf);

    expect(model.entities.size).toBe(1);
    expect(model.entities.get(1)?.type_name).toBe('IfcWall');
    expect(model.entities.get(1)?.global_id).toBe('GUID-1');

    expect(model.relationships).toHaveLength(1);
    expect(model.relationships[0]).toEqual({
      rel_type: 'IfcRelAggregates',
      relating_id: 1,
      related_id: 2,
    });

    expect(model.spatialHierarchy.project_id).toBe(42);
    expect(model.spatialHierarchy.nodes).toHaveLength(1);
    expect(model.spatialHierarchy.nodes[0].entity_id).toBe(1);
    expect(model.spatialHierarchy.nodes[0].type_name).toBe('IfcProject');

    // No optional sections appended -> older-payload path.
    expect(model.classifications).toEqual([]);
    expect(model.materials).toEqual([]);
    expect(model.documents).toEqual([]);
  });

  it('decodes a model with legitimately EMPTY required tables (zero quantities, zero relationships)', async () => {
    const buf = buildDataModelBuffer({ emptyQuantities: true, emptyRelationships: true });
    const model = await decodeDataModel(buf);

    // Zero rows is legitimate; the section's ENCODED BYTE LENGTH is still
    // non-zero (Parquet magic + schema + footer), so the required-section
    // bounds check must not reject it.
    expect(model.quantitySets.size).toBe(0);
    expect(model.relationships).toEqual([]);
    // The rest of the model still decodes correctly around the empty tables.
    expect(model.entities.size).toBe(1);
    expect(model.spatialHierarchy.nodes).toHaveLength(1);
  });
});
