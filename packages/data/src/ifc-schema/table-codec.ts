/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact, exact encoding of the generated schema tables in `./generated/`.
 *
 * WHY. The tables were emitted as object literals: `attributes.ts` alone was
 * 1 MB of source. Every bundle carrying them (the browser viewer's main
 * thread and its parser, alignment, overlay and compression workers)
 * compiled and evaluated all of it on load. The same few thousand entity
 * names recur thousands of times. The encoded form names every string once
 * and every object shape (its key list) once; the generated modules hold it as
 * one string literal and decode it the first time it is asked for.
 *
 * FORMAT. `{ s, k, v }`: `s` is the string table, `k` the shape table (each a
 * list of key ids), `v` the encoded value. A string is its id (>= 0); `true`,
 * `false`, `undefined` and `null` are -1, -2, -3 and -4; a number is
 * `[-1, n]`; an array is `[0, ...items]`; an object is `[1 + shape, ...values]`
 * in its shape's key order.
 *
 * EXACTNESS. Decoding gives the value that was encoded: the same keys in the
 * same order, keys whose value is `undefined` still present (the entity rows
 * spell `parent: undefined` for a root), fresh objects and arrays.
 * {@link encodeSchemaTable} decodes its own output and refuses to return an
 * encoding that differs.
 */

type Encoded = number | Encoded[];

interface EncodedTable {
  s: string[];
  k: number[][];
  v: Encoded;
}

/** Decode a table emitted by {@link encodeSchemaTable}. */
export function decodeSchemaTable(text: string): unknown {
  const table = JSON.parse(text) as EncodedTable;
  const s = table.s;
  const shapes = table.k.map((keys) => keys.map((i) => s[i]));
  const decode = (x: Encoded): unknown => {
    if (typeof x === 'number') {
      if (x >= 0) return s[x];
      return x === -1 ? true : x === -2 ? false : x === -3 ? undefined : null;
    }
    const tag = x[0] as number;
    if (tag === -1) return x[1];
    if (tag === 0) {
      const out: unknown[] = new Array(x.length - 1);
      for (let i = 1; i < x.length; i++) out[i - 1] = decode(x[i]);
      return out;
    }
    const keys = shapes[tag - 1];
    const out: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) out[keys[i]] = decode(x[i + 1]);
    return out;
  };
  return decode(table.v);
}

/** Same keys in the same order, same values, `undefined`-valued keys kept. */
export function schemaTableFingerprint(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v === undefined ? { __undefined__: true } : v));
}

/**
 * Encode a plain data value (strings, booleans, finite numbers, null,
 * undefined, arrays, plain objects) as the JSON text the generated modules
 * embed. Throws on anything else, and unless the text decodes back to exactly
 * `value`.
 */
export function encodeSchemaTable(value: unknown): string {
  const strings: string[] = [];
  const stringIds = new Map<string, number>();
  const str = (x: string): number => {
    let i = stringIds.get(x);
    if (i === undefined) { i = strings.length; strings.push(x); stringIds.set(x, i); }
    return i;
  };
  const shapes: number[][] = [];
  const shapeIds = new Map<string, number>();
  const shape = (keys: string[]): number => {
    const key = JSON.stringify(keys);
    let i = shapeIds.get(key);
    if (i === undefined) { i = shapes.length; shapes.push(keys.map(str)); shapeIds.set(key, i); }
    return i;
  };
  const encode = (x: unknown): Encoded => {
    if (typeof x === 'string') return str(x);
    if (x === true) return -1;
    if (x === false) return -2;
    if (x === undefined) return -3;
    if (x === null) return -4;
    if (typeof x === 'number') {
      if (!Number.isFinite(x) || Object.is(x, -0)) throw new Error(`schema table: cannot encode number ${x}`);
      return [-1, x];
    }
    if (Array.isArray(x)) return [0, ...x.map(encode)];
    if (typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      const record = x as Record<string, unknown>;
      const keys = Object.keys(record);
      return [1 + shape(keys), ...keys.map((k) => encode(record[k]))];
    }
    throw new Error(`schema table: cannot encode a ${typeof x}`);
  };
  const v = encode(value);
  const text = JSON.stringify({ s: strings, k: shapes, v });
  if (schemaTableFingerprint(decodeSchemaTable(text)) !== schemaTableFingerprint(value)) {
    throw new Error('schema table: encoding does not round-trip');
  }
  return text;
}

const eagerTablesEvaluated: string[] = [];

/**
 * The exported-constant form of a table (or of a value derived from one):
 * `export const X = /* @__PURE__ *\/ eagerSchemaTable('ifc-lite-eager-table:X', getX)`.
 * Returns `get()`, so the constant is the same object the getter returns.
 *
 * A bundler drops the constant when nothing references it; any reference
 * keeps it, and it is then decoded when its chunk loads. The marker is what
 * makes that visible in a built bundle: it survives exactly where the
 * constant does, and `apps/viewer/scripts/check-schema-tables-lazy.mjs` fails
 * the viewer build if a startup chunk carries one. Code that may not need a
 * table at load time calls the getter instead.
 */
export function eagerSchemaTable<T>(marker: string, get: () => T): T {
  eagerTablesEvaluated.push(marker);
  return get();
}

/** Markers of the eager constants evaluated so far in this realm, in order. */
export function eagerSchemaTablesEvaluated(): readonly string[] {
  return [...eagerTablesEvaluated];
}
