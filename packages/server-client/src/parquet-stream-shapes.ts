/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The client half of cross-batch shape sharing on
 * `POST /api/v1/parse/parquet-stream?stream_shapes=cross-batch` (issue #5407).
 *
 * On that stream a batch carries only the shapes no earlier batch did, and its
 * mesh rows index the vertex and index rows of the WHOLE stream so far. So the
 * reader keeps every batch's vertex and index columns, appended in order, and
 * builds each batch's meshes against all of them. What it keeps is the
 * stream's distinct shape geometry, sent once, which is what makes the stream
 * small in the first place; occurrences are materialized per batch and handed
 * off exactly as before.
 *
 * Each batch states where its tables start (`vertex_base`, `index_base`). The
 * store refuses a batch whose base is not what it holds, so a dropped or
 * reordered batch fails loud instead of drawing one shape's vertices for
 * another. A batch WITHOUT bases came from a server that did not honour the
 * opt-in and decodes on its own, as every batch did before.
 */

import type { MeshData } from './types.js';
import { numericColumn } from './parquet-columns.js';
import { readFlatTables } from './parquet-decoder.js';
import { buildMeshesFromTables, type ArrowTableLike } from './parquet-tables.js';

const VERTEX_COLUMNS = ['x', 'y', 'z', 'nx', 'ny', 'nz'] as const;
const INDEX_COLUMNS = ['i0', 'i1', 'i2'] as const;

/** An append-only typed column that doubles its capacity as it grows. */
class GrowableColumn {
  private buffer: Float32Array | Uint32Array;
  private length = 0;

  constructor(private readonly allocate: (capacity: number) => Float32Array | Uint32Array) {
    this.buffer = allocate(1024);
  }

  append(values: ArrayLike<number>): void {
    const needed = this.length + values.length;
    if (needed > this.buffer.length) {
      const grown = this.allocate(Math.max(needed, this.buffer.length * 2));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(values, this.length);
    this.length = needed;
  }

  view(): Float32Array | Uint32Array {
    return this.buffer.subarray(0, this.length);
  }
}

function columns(names: readonly string[], allocate: (n: number) => Float32Array | Uint32Array) {
  return new Map(names.map((name) => [name, new GrowableColumn(allocate)]));
}

function tableOf(cols: Map<string, GrowableColumn>): ArrowTableLike {
  return {
    getChild(name) {
      const view = cols.get(name)?.view();
      return view ? { toArray: () => view, get: (i) => view[i] } : null;
    },
  };
}

/** Every vertex and index row a cross-batch stream has sent so far. */
export class StreamShapeStore {
  private readonly vertex = columns(VERTEX_COLUMNS, (n) => new Float32Array(n));
  private readonly index = columns(INDEX_COLUMNS, (n) => new Uint32Array(n));
  /** Vertex rows received. */
  private vertices = 0;
  /** Indices received, three per index-table row: the unit of `index_base`. */
  private indices = 0;

  /**
   * Append one batch's vertex and index tables at the bases the batch states.
   * Throws, appending nothing, when a base is not what the store holds or a
   * table is malformed.
   */
  append(vertexArrow: ArrowTableLike, indexArrow: ArrowTableLike, vertexBase: number, indexBase: number): void {
    if (vertexBase !== this.vertices || indexBase !== this.indices) {
      throw new Error(
        `Malformed Parquet stream: batch starts at vertex ${vertexBase} / index ${indexBase}, ` +
          `but ${this.vertices} / ${this.indices} were received (a batch is missing or out of order)`
      );
    }
    const vertexCols = parallelColumns(vertexArrow, VERTEX_COLUMNS);
    const indexCols = parallelColumns(indexArrow, INDEX_COLUMNS);
    VERTEX_COLUMNS.forEach((name, i) => this.vertex.get(name)?.append(vertexCols[i]));
    INDEX_COLUMNS.forEach((name, i) => this.index.get(name)?.append(indexCols[i]));
    this.vertices += vertexCols[0].length;
    this.indices += 3 * indexCols[0].length;
  }

  vertexTable(): ArrowTableLike {
    return tableOf(this.vertex);
  }

  indexTable(): ArrowTableLike {
    return tableOf(this.index);
  }
}

/** All of `names`, present and of one length, or throw. */
function parallelColumns(table: ArrowTableLike, names: readonly string[]): ArrayLike<number>[] {
  const cols: ArrayLike<number>[] = [];
  for (const name of names) {
    const col = numericColumn(table, name);
    if (!col || (cols.length > 0 && col.length !== cols[0].length)) {
      throw new Error(`Malformed Parquet stream: missing or ragged ${names.join('/')} columns`);
    }
    cols.push(col);
  }
  return cols;
}

/**
 * Decode one cross-batch stream batch against everything the stream has sent:
 * append its tables to `store`, then build its meshes, whose ranges may reach
 * back into any earlier batch.
 */
export async function decodeCrossBatch(
  data: ArrayBuffer,
  store: StreamShapeStore,
  vertexBase: number,
  indexBase: number
): Promise<MeshData[]> {
  const { meshArrow, vertexArrow, indexArrow } = await readFlatTables(data);
  store.append(vertexArrow, indexArrow, vertexBase, indexBase);
  return buildMeshesFromTables(meshArrow, store.vertexTable(), store.indexTable());
}
