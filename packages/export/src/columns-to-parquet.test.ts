/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Column typing for the Parquet writer.
 *
 * The assertions here are all about VALUES SURVIVING THE ROUND TRIP, because
 * every failure in this area produces a file that opens cleanly and reads
 * wrong: an express id that came back negative still looks like an id, and a
 * whole-number float that came back as an integer still looks like a number.
 *
 * Each case reads the bytes back with the reader, rather than inspecting the
 * schema we asked for. What a consumer gets is the only thing that matters.
 */

import { describe, expect, it } from 'vitest';
import { columnsToParquet, isParquet } from './columns-to-parquet.js';

/** Read a Parquet buffer back into plain column arrays. */
async function readBack(bytes: Uint8Array): Promise<Record<string, unknown[]>> {
  const { readParquet } = await import('parquet-wasm');
  const { tableFromIPC } = await import('apache-arrow');
  const table = tableFromIPC(readParquet(bytes).intoIPCStream());
  const out: Record<string, unknown[]> = {};
  for (const field of table.schema.fields) {
    const column = table.getChild(field.name);
    out[field.name] = Array.from({ length: table.numRows }, (_, i) => column?.get(i) ?? null);
  }
  return out;
}

/** The Arrow type a column came back as, e.g. `Uint32`. Asserting on this is
 *  what makes an EMPTY column's test able to fail: an untyped empty column is
 *  still valid Parquet, so `isParquet` alone passes either way. */
async function readBackType(bytes: Uint8Array, column: string): Promise<string> {
  const { readParquet } = await import('parquet-wasm');
  const { tableFromIPC } = await import('apache-arrow');
  const table = tableFromIPC(readParquet(bytes).intoIPCStream());
  return String(table.schema.fields.find((f) => f.name === column)?.type ?? 'missing');
}

/** 2^31: the first value Int32 cannot hold. An express id may legitimately be
 *  here - STEP bounds entity ids only by the `u32` the readers use, and this
 *  repo stores them in `Uint32Array` throughout. */
const OVER_INT32 = 2_147_483_648;

describe('columnsToParquet: unsigned columns', () => {
  it('brings an express id above 2^31 back unchanged', async () => {
    // Without the declaration this came back as -2147483648: an id-shaped
    // number that joins to nothing, in a file that opens perfectly.
    const bytes = await columnsToParquet(
      { ExpressId: [1, OVER_INT32, 4_294_967_295], Name: ['a', 'b', 'c'] },
      undefined,
      new Set(['ExpressId']),
    );
    expect(isParquet(bytes)).toBe(true);
    const table = await readBack(bytes);
    expect(table.ExpressId).toEqual([1, OVER_INT32, 4_294_967_295]);
  });

  it('wraps that same id when the column is NOT declared unsigned', async () => {
    // The counterfactual, so the test above cannot pass for an unrelated
    // reason: inference alone reaches for Int32 and the value goes negative.
    const bytes = await columnsToParquet({ ExpressId: [OVER_INT32] });
    const table = await readBack(bytes);
    expect(table.ExpressId[0]).toBe(-2_147_483_648);
  });

  it('keeps an empty unsigned column typed, so two exports share a schema', async () => {
    // The point is the SCHEMA, not merely that the bytes are Parquet: an
    // untyped empty column also writes valid Parquet, just with a different
    // type, so an export whose ids happened to be empty would disagree with
    // the next one that had rows. Asserting the type is what makes this able
    // to fail at all.
    const bytes = await columnsToParquet({ ExpressId: [] }, undefined, new Set(['ExpressId']));
    expect(isParquet(bytes)).toBe(true);
    expect(await readBackType(bytes, 'ExpressId')).toBe('Uint32');
  });

  it('keeps an all-null unsigned column typed too', async () => {
    const bytes = await columnsToParquet(
      { ExpressId: [null, null] },
      undefined,
      new Set(['ExpressId']),
    );
    expect(await readBackType(bytes, 'ExpressId')).toBe('Uint32');
    expect((await readBack(bytes)).ExpressId).toEqual([null, null]);
  });

  it('leaves a column the caller did NOT declare alone', async () => {
    // The counterfactual for both of the above: without the declaration the
    // empty column is typed by the fallback rather than by the domain.
    expect(await readBackType(await columnsToParquet({ ExpressId: [] }), 'ExpressId')).not.toBe('Uint32');
  });

  it('keeps a whole-number float a float', async () => {
    // The same class as the id wrap, in the other direction: a quantity of
    // exactly 3 must not come back as an integer column, or the next export
    // with 3.5 in it changes the file's schema.
    const bytes = await columnsToParquet({ Value: [3, 1200] }, new Set(['Value']));
    const table = await readBack(bytes);
    expect(table.Value).toEqual([3, 1200]);
    const raw = await columnsToParquet({ Value: [3, 1200] });
    expect(isParquet(raw)).toBe(true);
  });
});

describe('isParquet', () => {
  it('recognizes the magic at both ends, and rejects anything else', async () => {
    expect(isParquet(await columnsToParquet({ a: [1] }))).toBe(true);
    expect(isParquet(new TextEncoder().encode('ARROW1not-parquet'))).toBe(false);
    expect(isParquet(new Uint8Array(2))).toBe(false);
  });
});
