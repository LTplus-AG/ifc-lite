/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BVH build-order parity with the Rust port (#7674). `rust/clash/src/bvh.rs`
 * ports this BVH for the clash kernel, and both sides read the same vectors
 * from `rust/clash/tests/fixtures/bvh_order_parity.txt`. A query returns ids
 * in depth-first leaf order, so each expected list pins the tree shape, not
 * only the hit set. The cases cover centre ties below the root, `-0` vs `+0`
 * centres, NaN and infinite bounds, and more than 20 items with NaN centres.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AABB } from './aabb.js';
import { BVH, type MeshWithBounds } from './bvh.js';

const FIXTURE = fileURLToPath(
  new URL('../../../rust/clash/tests/fixtures/bvh_order_parity.txt', import.meta.url),
);

interface ParityQuery {
  bounds: AABB;
  expected: number[];
}

interface ParityCase {
  name: string;
  items: MeshWithBounds[];
  queries: ParityQuery[];
}

function num(field: string): number {
  const value = Number(field);
  if (Number.isNaN(value) && field !== 'NaN') throw new Error(`bad number ${field}`);
  return value;
}

function box(fields: string[]): AABB {
  const v = fields.map(num);
  return { min: [v[0], v[1], v[2]], max: [v[3], v[4], v[5]] };
}

function parseCases(text: string): ParityCase[] {
  const cases: ParityCase[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    const current = cases[cases.length - 1];
    if (fields[0] === 'case') {
      cases.push({ name: fields[1], items: [], queries: [] });
    } else if (fields[0] === 'item' && current) {
      current.items.push({ expressId: Number(fields[1]), bounds: box(fields.slice(2, 8)) });
    } else if (fields[0] === 'query' && current && fields[7] === '=>') {
      current.queries.push({ bounds: box(fields.slice(1, 7)), expected: fields.slice(8).map(Number) });
    } else {
      throw new Error(`unparseable parity line: ${line}`);
    }
  }
  return cases;
}

const cases = parseCases(readFileSync(FIXTURE, 'utf8'));

describe('BVH build order matches the Rust clash port', () => {
  it('still holds the cases the vectors exist for', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    const nanPastCutoff = cases.some(
      (c) => c.items.length > 20 && c.items.some((m) => Number.isNaN(m.bounds.min[0])),
    );
    expect(nanPastCutoff).toBe(true);
  });

  for (const c of cases) {
    it(`case ${c.name}`, () => {
      const bvh = BVH.build(c.items);
      for (const q of c.queries) {
        expect(bvh.queryAABB(q.bounds)).toEqual(q.expected);
      }
    });
  }
});
