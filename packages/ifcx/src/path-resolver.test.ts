/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PathIndex } from './path-resolver.js';
import type { IfcxLayer } from './layer-stack.js';
import type { IfcxNode } from './types.js';

/** Build a minimal single-layer stack from `path -> children` definitions. */
function layerWith(nodes: IfcxNode[]): IfcxLayer {
  const nodesByPath = new Map<string, IfcxNode[]>();
  for (const node of nodes) nodesByPath.set(node.path, [node]);
  return {
    id: 'layer-1',
    name: 'test',
    file: {
      header: { id: 'h', ifcxVersion: '1', dataVersion: '1', author: 't', timestamp: '' },
      imports: [],
      schemas: {},
      data: nodes,
    },
    buffer: new ArrayBuffer(0),
    strength: 0,
    enabled: true,
    source: { type: 'buffer', name: 'test' },
    nodesByPath,
    loadedAt: 0,
  };
}

describe('PathIndex.buildIndex cycle safety', () => {
  it('terminates on a child cycle instead of overflowing the stack', () => {
    // A -> B -> A: a malformed IFCX layer. Without an ancestor guard the
    // hierarchical index recursion never returns.
    const index = new PathIndex();
    index.buildIndex([
      layerWith([
        { path: 'A', children: { toB: 'B' } },
        { path: 'B', children: { toA: 'A' } },
      ]),
    ]);
    // Both directions still resolve one hop; the cycle is simply not followed
    // back onto an ancestor.
    assert.equal(index.resolvePath('A/toB'), 'B');
    assert.equal(index.resolvePath('B/toA'), 'A');
  });

  it('indexes a diamond (shared, non-ancestral child) under both parents', () => {
    // A -> D and A -> C -> D: D is reached by two distinct paths and must be
    // indexed under both (only true ancestry cycles are cut).
    const index = new PathIndex();
    index.buildIndex([
      layerWith([
        { path: 'A', children: { toD: 'D', toC: 'C' } },
        { path: 'C', children: { toD: 'D' } },
        { path: 'D', children: {} },
      ]),
    ]);
    assert.equal(index.resolvePath('A/toD'), 'D');
    assert.equal(index.resolvePath('A/toC/toD'), 'D');
  });
});
