/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct coverage for {@link buildEntityRefsFromIndex}.
 *
 * This is the fast path the parser worker takes when the streaming geometry
 * pre-pass has already scanned the file: the whole entity index is synthesised
 * from three SharedArrayBuffer columns without re-reading the source. Its two
 * corruption guards (column-length mismatch, out-of-bounds span) both survived
 * mutation because no test ever fed it a corrupt triple.
 */

import { describe, expect, it } from 'vitest';
import { buildEntityRefsFromIndex } from '../src/entity-refs-from-index.js';

const SOURCE = ["#10=IFCWALL('a',$);", '#2=IFCSLAB($);', '#7=IFCWALL($);'].join('\n');
const src = new TextEncoder().encode(SOURCE);

/** Byte spans of the three records above, in file order. */
const spans = (() => {
  const out: Array<{ id: number; start: number; len: number }> = [];
  let at = 0;
  for (const line of SOURCE.split('\n')) {
    out.push({ id: Number(line.slice(1, line.indexOf('='))), start: at, len: line.length });
    at += line.length + 1;
  }
  return out;
})();

const cols = (rows: typeof spans) => ({
  ids: Uint32Array.from(rows.map((r) => r.id)),
  starts: Uint32Array.from(rows.map((r) => r.start)),
  lengths: Uint32Array.from(rows.map((r) => r.len)),
});

describe('buildEntityRefsFromIndex', () => {
  it('extracts the type token and byte span for each column entry', () => {
    const { ids, starts, lengths } = cols(spans);
    const refs = buildEntityRefsFromIndex(src, ids, starts, lengths);
    expect(refs.map((r) => r.expressId)).toEqual([2, 7, 10]);
    expect(refs.map((r) => r.type)).toEqual(['IFCSLAB', 'IFCWALL', 'IFCWALL']);
    for (const ref of refs) {
      const span = spans.find((s) => s.id === ref.expressId)!;
      expect(ref.byteOffset).toBe(span.start);
      expect(ref.byteLength).toBe(span.len);
    }
  });

  it('emits refs in ascending expressId order regardless of column order', () => {
    // The downstream compact index only skips its O(N log N) object sort when
    // the refs already ascend; descending output would be a silent slowdown
    // and, for consumers that assume order, a wrong answer.
    const { ids, starts, lengths } = cols(spans);
    const refs = buildEntityRefsFromIndex(src, ids, starts, lengths);
    const seen = refs.map((r) => r.expressId);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  // NOT "interns one string per distinct type name". Interning is not
  // observable from JS: `expect(a).toBe(b)` is `Object.is`, which compares
  // string PRIMITIVES by value, so two independently-built equal strings
  // satisfy it. Verified — replacing the intern lookup with
  // `(' ' + key).slice(1)`, and separately with `Array.from(key).join('')`,
  // both left this file green. The intern Map is a memory optimisation with
  // no behavioural contract; what IS falsifiable is that every occurrence of
  // a repeated type resolves to the same NAME, which is what this asserts.
  it('resolves the same type name for every occurrence of a repeated type', () => {
    const { ids, starts, lengths } = cols(spans);
    const refs = buildEntityRefsFromIndex(src, ids, starts, lengths);
    const walls = refs.filter((r) => r.type === 'IFCWALL');
    expect(walls).toHaveLength(2);
    expect(walls.map((r) => r.type)).toEqual(['IFCWALL', 'IFCWALL']);
  });

  it('tolerates whitespace between `=` and the type token', () => {
    const padded = new TextEncoder().encode('#1=  IFCWALL($);');
    const refs = buildEntityRefsFromIndex(
      padded,
      Uint32Array.of(1),
      Uint32Array.of(0),
      Uint32Array.of(padded.length),
    );
    expect(refs[0].type).toBe('IFCWALL');
  });

  it('throws when the `lengths` column is shorter than the `ids` column', () => {
    // Each column is checked independently; a guard that only validates
    // `starts` lets a truncated `lengths` column through as undefined spans.
    expect(() =>
      buildEntityRefsFromIndex(src, Uint32Array.of(2, 7), Uint32Array.of(0, 19), Uint32Array.of(13)),
    ).toThrow(/column-length mismatch/);
  });

  it('throws when the `starts` column is shorter than the `ids` column', () => {
    expect(() =>
      buildEntityRefsFromIndex(src, Uint32Array.of(2, 7), Uint32Array.of(0), Uint32Array.of(13, 13)),
    ).toThrow(/column-length mismatch/);
  });

  it('throws when a span ends past the end of the source', () => {
    // The start is in range but start+len walks off the buffer. Clamping would
    // silently emit a truncated record with an empty type name.
    expect(() =>
      buildEntityRefsFromIndex(
        src,
        Uint32Array.of(2),
        Uint32Array.of(0),
        Uint32Array.of(src.length + 1),
      ),
    ).toThrow(/out-of-bounds span/);
  });

  it('throws when a span starts past the end of the source', () => {
    expect(() =>
      buildEntityRefsFromIndex(src, Uint32Array.of(2), Uint32Array.of(src.length + 1), Uint32Array.of(0)),
    ).toThrow(/out-of-bounds span/);
  });

  it('accepts a span that ends exactly at the end of the source', () => {
    const last = spans[spans.length - 1];
    const refs = buildEntityRefsFromIndex(
      src,
      Uint32Array.of(last.id),
      Uint32Array.of(last.start),
      Uint32Array.of(last.len),
    );
    expect(refs[0].byteOffset + refs[0].byteLength).toBe(src.length);
  });

  it('returns an empty array for empty columns', () => {
    expect(
      buildEntityRefsFromIndex(src, new Uint32Array(0), new Uint32Array(0), new Uint32Array(0)),
    ).toEqual([]);
  });
});
