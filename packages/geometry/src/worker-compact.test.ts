/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { COMPACT_TABLE_STRIDE as STRIDE, isCompactCellSize } from './compact-geometry.js';
import { encodeSessionCompact, setCompactCellSize, tagCompactMesh, takeSessionCompact } from './worker-compact.js';

/** A wasm `MeshCollection` stand-in whose encoder takes `rows` meshes of one vertex and one triangle each. */
function fakeCollection(rows: number) {
  return {
    encodeCompact: (cellSize: number) => ({
      meshCount: rows,
      records: new Uint8Array(rows * 12), indices: new Uint16Array(rows * 3),
      table: Uint32Array.from({ length: rows * STRIDE }, (_, i) => (i % STRIDE === 0 ? i / STRIDE + 10 : i % STRIDE === 5 ? 10 : 0)),
      windows: new Float64Array(rows * 3), bounds: new Float64Array(rows * 6).fill(cellSize), cells: new Int32Array(rows * 3),
      free: () => undefined,
    }),
  };
}

afterEach(() => setCompactCellSize(null));

describe('the worker side of compact geometry', () => {
  it('encodes nothing until the host sets a cell size', () => {
    const session = { cumulativeMeshBytes: 0 };
    expect(encodeSessionCompact(session, fakeCollection(2))).toBeUndefined();
    expect(takeSessionCompact(session, [])).toEqual({});
    expect(session.cumulativeMeshBytes).toBe(0);
  });

  it.each([0, -32, Number.NaN, Number.POSITIVE_INFINITY])('stays off for a cell size of %s, as the host and the cache gate judge it', (size) => {
    expect(isCompactCellSize(size)).toBe(false);
    setCompactCellSize(size);
    expect(encodeSessionCompact({ cumulativeMeshBytes: 0 }, fakeCollection(2))).toBeUndefined();
    expect(isCompactCellSize(32)).toBe(true);
    expect(isCompactCellSize(undefined)).toBe(false);
  });

  it('tags encoded meshes, counts their records as geometry bytes and hands the payloads to the next post', () => {
    setCompactCellSize(32);
    const session = { cumulativeMeshBytes: 0 };
    const rows = encodeSessionCompact(session, fakeCollection(2))!;
    // Collection indices 10 and 11 were encoded as rows 0 and 1 of this session's first payload.
    expect([...rows]).toEqual([[10, { batch: 0, row: 0 }], [11, { batch: 0, row: 1 }]]);
    const bytes = 2 * (12 + 3 * 2 + STRIDE * 4 + 3 * 8 + 6 * 8 + 3 * 4);
    expect(session.cumulativeMeshBytes).toBe(bytes);

    const tagged = {}, plain = {};
    tagCompactMesh(tagged, rows, 11);
    tagCompactMesh(plain, rows, 12);
    expect(tagged).toEqual({ compact: { batch: 0, row: 1 } });
    expect(plain).toEqual({});

    const transfers: ArrayBuffer[] = [];
    const message = takeSessionCompact(session, transfers);
    expect(message.compactBatches).toHaveLength(1);
    expect(transfers).toHaveLength(6);
    expect(transfers.reduce((sum, buffer) => sum + buffer.byteLength, 0)).toBe(bytes);
    expect(takeSessionCompact(session, [])).toEqual({});
  });

  it('keeps each session to its own payloads', () => {
    setCompactCellSize(32);
    const a = { cumulativeMeshBytes: 0 }, b = { cumulativeMeshBytes: 0 };
    encodeSessionCompact(a, fakeCollection(1));
    expect(takeSessionCompact(b, [])).toEqual({});
    expect(takeSessionCompact(a, []).compactBatches).toHaveLength(1);
  });
});
