/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `walkPlacementChain` against the vectors the Rust resolver is also tested
 * on (`rust/geometry/tests/placement_chain_parity.rs`), #7791 item 4.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { walkPlacementChain } from './placement-chain.js';

interface Vector {
  name: string;
  links: Record<string, { parent: number | null; offset: [number, number, number] }>;
  start: number;
  expect: { kind: 'ok'; chain: number[]; origin: number[] } | { kind: 'cycle'; revisited: number };
}

const vectors = (
  JSON.parse(
    readFileSync(
      new URL('../../../rust/geometry/tests/fixtures/placement_chain_vectors.json', import.meta.url),
      'utf8',
    ),
  ) as { vectors: Vector[] }
).vectors;

describe('walkPlacementChain: Rust parity vectors', () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      const parentOf = (id: number) => vector.links[String(id)]?.parent;
      const chain = walkPlacementChain(vector.start, parentOf);
      if (vector.expect.kind === 'cycle') {
        expect(chain.end).toBe('cycle');
        expect(chain.revisited).toBe(vector.expect.revisited);
        return;
      }
      expect(chain.end).toBe('root');
      expect([...chain.ids]).toEqual(vector.expect.chain);
      // The composed world origin: the offsets of exactly the walked links.
      const origin = [0, 0, 0];
      for (const id of chain.ids) {
        const offset = vector.links[String(id)]!.offset;
        for (let axis = 0; axis < 3; axis++) origin[axis]! += offset[axis]!;
      }
      expect(origin).toEqual(vector.expect.origin);
    });
  }
});

describe('walkPlacementChain', () => {
  it('has no depth cap: a 10 000-link chain walks in full without recursion', () => {
    const chain = walkPlacementChain(10_000, (id) => (id > 1 ? id - 1 : null));
    expect(chain.end).toBe('root');
    expect(chain.ids).toHaveLength(10_000);
  });

  it('stops inclusively at an ancestor the caller already knows', () => {
    const chain = walkPlacementChain(5, (id) => id - 1, { stopAt: (id) => id === 3 });
    expect([...chain.ids]).toEqual([5, 4, 3]);
    expect(chain.end).toBe('stopped');
  });

  it('treats an unreadable parent (undefined) as the end of the chain', () => {
    expect(walkPlacementChain(7, () => undefined)).toEqual({ ids: [7], end: 'root' });
  });
});
