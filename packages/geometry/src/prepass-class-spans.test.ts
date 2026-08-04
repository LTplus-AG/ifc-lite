/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  extractPrepassSpanLists,
  PREPASS_CLASS_CODE_MASK,
  PREPASS_CLASS_STYLED_ITEM,
  PREPASS_CLASS_INDEXED_COLOUR_MAP,
  PREPASS_CLASS_MATERIAL_DEF_REPR,
  PREPASS_CLASS_REL_ASSOCIATES_MATERIAL,
  PREPASS_CLASS_REL_VOIDS,
  PREPASS_CLASS_REL_FILLS,
  PREPASS_CLASS_REL_AGGREGATES,
} from './geometry-parallel.js';

/** Flag bits the producer composes ON TOP of a named code (Rust side). */
const FLAG_GEOMETRY_JOB = 0x80;
const FLAG_TYPE_CANDIDATE = 0x40;

/** Build the four stitched columns for `n` records with the given classes. */
function columns(classes: number[]) {
  const n = classes.length;
  const ids = new Uint32Array(n);
  const starts = new Uint32Array(n);
  const lengths = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    ids[i] = 100 + i;
    starts[i] = 1000 + i * 10;
    lengths[i] = 5 + i;
  }
  return { classes: new Uint8Array(classes), ids, starts, lengths };
}

/** The `(id, start, length)` triples in a span list, as plain arrays. */
function triples(spans: Uint32Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < spans.length; i += 3) out.push([spans[i], spans[i + 1], spans[i + 2]]);
  return out;
}

describe('extractPrepassSpanLists (prepass class byte -> span lists)', () => {
  it('keeps a record whose class carries a FLAG bit alongside the named code', () => {
    // The producer defines the class byte as a named code in the low bits PLUS
    // flag bits, so `0x80 | 4` is still a styled item. Comparing the raw byte
    // drops it silently (`spanLists.get(132)` is undefined) — mask first.
    const c = columns([FLAG_GEOMETRY_JOB | PREPASS_CLASS_STYLED_ITEM]);
    const spans = extractPrepassSpanLists(c.classes, c.ids, c.starts, c.lengths);
    expect(triples(spans.get(PREPASS_CLASS_STYLED_ITEM)!)).toEqual([[100, 1000, 5]]);
  });

  it('keeps flagged records for every host-consumed class, in file order', () => {
    const kinds = [
      PREPASS_CLASS_STYLED_ITEM,
      PREPASS_CLASS_INDEXED_COLOUR_MAP,
      PREPASS_CLASS_MATERIAL_DEF_REPR,
      PREPASS_CLASS_REL_ASSOCIATES_MATERIAL,
      PREPASS_CLASS_REL_VOIDS,
      PREPASS_CLASS_REL_FILLS,
      PREPASS_CLASS_REL_AGGREGATES,
    ];
    // Two records per class: one plain, one carrying both flag bits.
    const c = columns(kinds.flatMap((k) => [k, FLAG_GEOMETRY_JOB | FLAG_TYPE_CANDIDATE | k]));
    const spans = extractPrepassSpanLists(c.classes, c.ids, c.starts, c.lengths);
    for (let k = 0; k < kinds.length; k++) {
      const list = spans.get(kinds[k])!;
      expect(list.length).toBe(6); // 2 records x 3 columns, exact-size
      // File order: the plain record (index 2k) precedes the flagged one.
      expect(triples(list).map((t) => t[0])).toEqual([100 + 2 * k, 101 + 2 * k]);
    }
  });

  it('keeps plain unflagged records in their own list and nowhere else', () => {
    const c = columns([PREPASS_CLASS_STYLED_ITEM, PREPASS_CLASS_REL_VOIDS]);
    const spans = extractPrepassSpanLists(c.classes, c.ids, c.starts, c.lengths);
    expect(triples(spans.get(PREPASS_CLASS_STYLED_ITEM)!)).toEqual([[100, 1000, 5]]);
    expect(triples(spans.get(PREPASS_CLASS_REL_VOIDS)!)).toEqual([[101, 1010, 6]]);
    expect(spans.get(PREPASS_CLASS_INDEXED_COLOUR_MAP)!.length).toBe(0);
  });

  it('excludes records whose MASKED code is not one the host consumes', () => {
    // 0 none, 2 project, 3 site, 11 mapped item, 12 rel-defines-by-type,
    // 13 material layer set — plus the same codes carrying flag bits, and a
    // pure-flag byte. None of these may reach a host span list.
    const excluded = [0, 2, 3, 11, 12, 13].flatMap((k) => [k, FLAG_GEOMETRY_JOB | k]);
    const c = columns([...excluded, FLAG_GEOMETRY_JOB, FLAG_TYPE_CANDIDATE]);
    const spans = extractPrepassSpanLists(c.classes, c.ids, c.starts, c.lengths);
    for (const [, list] of spans) expect(list.length).toBe(0);

    // Again with ONE styled record, placed last: a consumer that funnelled
    // unrecognised codes into a list would fill the styled slots ahead of the
    // real record (whose triple would then be silently dropped on overflow).
    const withStyled = columns([...excluded, PREPASS_CLASS_STYLED_ITEM]);
    const spans2 = extractPrepassSpanLists(
      withStyled.classes,
      withStyled.ids,
      withStyled.starts,
      withStyled.lengths,
    );
    const last = excluded.length;
    expect(triples(spans2.get(PREPASS_CLASS_STYLED_ITEM)!)).toEqual([
      [withStyled.ids[last], withStyled.starts[last], withStyled.lengths[last]],
    ]);
    for (const [k, list] of spans2) {
      if (k !== PREPASS_CLASS_STYLED_ITEM) expect(list.length).toBe(0);
    }
  });
});

// The class codes above are a restatement of the Rust producer's constants;
// pin them to that source of truth so the two cannot drift silently (the whole
// point of the mask being applied on both sides). Skipped gracefully when this
// package is tested outside the monorepo.
const rustSource = fileURLToPath(
  new URL('../../../rust/processing/src/shard_classes.rs', import.meta.url),
);

describe.skipIf(!existsSync(rustSource))('prepass class constants match the Rust source', () => {
  // Guarded read: with skipIf active the describe body still runs at collection
  // time, so an unguarded readFileSync would hard-fail instead of skipping.
  const src = existsSync(rustSource) ? readFileSync(rustSource, 'utf8') : '';
  const rustConst = (name: string): number | undefined => {
    const m = new RegExp(`pub const ${name}: u8 = (0x[0-9a-fA-F]+|\\d+);`).exec(src);
    return m ? Number(m[1]) : undefined;
  };

  it.each([
    ['PREPASS_CLASS_CODE_MASK', PREPASS_CLASS_CODE_MASK],
    ['PREPASS_CLASS_STYLED_ITEM', PREPASS_CLASS_STYLED_ITEM],
    ['PREPASS_CLASS_INDEXED_COLOUR_MAP', PREPASS_CLASS_INDEXED_COLOUR_MAP],
    ['PREPASS_CLASS_MATERIAL_DEF_REPR', PREPASS_CLASS_MATERIAL_DEF_REPR],
    ['PREPASS_CLASS_REL_ASSOCIATES_MATERIAL', PREPASS_CLASS_REL_ASSOCIATES_MATERIAL],
    ['PREPASS_CLASS_REL_VOIDS', PREPASS_CLASS_REL_VOIDS],
    ['PREPASS_CLASS_REL_FILLS', PREPASS_CLASS_REL_FILLS],
    ['PREPASS_CLASS_REL_AGGREGATES', PREPASS_CLASS_REL_AGGREGATES],
  ])('%s', (name, tsValue) => {
    expect(rustConst(name)).toBe(tsValue);
  });

  it('sizes the count table so no masked code can write out of bounds', () => {
    // Every named Rust code must fit under the mask, which is what makes
    // `Uint32Array(PREPASS_CLASS_CODE_MASK + 1)` safe for codes the host does
    // not yet know about.
    const named = [...src.matchAll(/pub const PREPASS_CLASS_(?!FLAG_|CODE_MASK)\w+: u8 = (\d+);/g)];
    expect(named.length).toBeGreaterThan(0);
    for (const m of named) expect(Number(m[1])).toBeLessThanOrEqual(PREPASS_CLASS_CODE_MASK);
  });
});
