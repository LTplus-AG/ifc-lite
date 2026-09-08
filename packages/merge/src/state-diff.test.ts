/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contract test for the shared layer-diff JSON (roadmap cross-cutting):
 * the exact wire shape — keys, ordering, tombstone handling — consumed
 * identically by `ifc layer diff --json`, the MCP `diff_layer` tool, and
 * the review UI. A change here is a breaking change for all three.
 */

import { describe, expect, it } from 'vitest';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import { diffLayerStacks, diffStackStates } from './state-diff.js';
import type { EntityState, StackState } from './component-state.js';

/** Minimal alive (non-deleted) entity for path-ordering tests below —
 *  no components, no children, so only presence/absence drives the diff. */
function bareEntity(path: string): EntityState {
  return {
    path,
    components: new Map(),
    children: new Map(),
    inherits: new Map(),
    deleted: false,
    explicitDeleted: false,
  };
}

function makeLayer(data: IfcxNode[], id: string): IfcxFile {
  return {
    header: { id, ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 'test', timestamp: 't' },
    imports: [],
    schemas: {},
    data,
  };
}

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const CLASS = 'bsi::ifc::class';

const base = makeLayer(
  [
    { path: 'storey', children: { WallA: 'wall-a', WallB: 'wall-b' } },
    { path: 'wall-a', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } },
    { path: 'wall-b', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } },
  ],
  'base'
);

describe('shared layer-diff JSON contract', () => {
  it('pins the exact wire shape: keys, deterministic ordering, component keys', () => {
    const delta: IfcxNode[] = [
      // modify wall-a's pset + reparent a slot on storey
      { path: 'wall-a', attributes: { [FIRE]: 'REI90' } },
      { path: 'storey', children: { WallB: null } },
      // delete wall-b, add slab-1
      { path: 'wall-b', attributes: { [IFCLITE_ATTR.DELETED]: true } },
      { path: 'slab-1', attributes: { [CLASS]: { code: 'IfcSlab', uri: 'u' } } },
    ];
    const diff = diffLayerStacks([base], [base, makeLayer(delta, 'delta')]);

    // Byte-exact: this literal IS the contract.
    expect(JSON.parse(JSON.stringify(diff))).toEqual({
      added: ['slab-1'],
      deleted: ['wall-b'],
      modified: [
        { path: 'storey', components: ['child:WallB'] },
        { path: 'wall-a', components: ['pset:Pset_FireSafety'] },
      ],
    });
    // Object key order is part of the wire shape.
    expect(Object.keys(diff)).toEqual(['added', 'deleted', 'modified']);
  });

  it('is deterministic: equal inputs serialize to byte-equal JSON', () => {
    const delta = makeLayer([{ path: 'wall-a', attributes: { [FIRE]: 'REI90' } }], 'delta');
    const a = JSON.stringify(diffLayerStacks([base], [base, delta]));
    const b = JSON.stringify(diffLayerStacks([base], [base, delta]));
    expect(a).toBe(b);
  });

  it('treats a tombstoned-and-untouched entity as unchanged on both sides', () => {
    const dead = makeLayer([{ path: 'wall-b', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'dead');
    const diff = diffLayerStacks([base, dead], [base, dead]);
    expect(diff).toEqual({ added: [], deleted: [], modified: [] });
  });

  it('sorts added/deleted paths, not just modified components — insertion order alone would not', () => {
    // `paths` is built from `[...from.keys(), ...to.keys()]`, so its natural
    // (unsorted) order is Map insertion order. Insert 'zebra' before 'apple'
    // on both sides: every OTHER test in this file only ever has a single
    // added/deleted path, where insertion order and sorted order coincide by
    // construction, so a build that dropped the `.sort()` on `paths` would
    // still pass them all. This pins the documented "paths ... sorted"
    // contract (see the file-level doc comment) with two paths whose
    // insertion order is deliberately the reverse of alphabetical.
    const from: StackState = new Map();
    const to: StackState = new Map([
      ['zebra', bareEntity('zebra')],
      ['apple', bareEntity('apple')],
    ]);
    expect(diffStackStates(from, to).added).toEqual(['apple', 'zebra']);

    const deletedFrom: StackState = new Map([
      ['zebra', bareEntity('zebra')],
      ['apple', bareEntity('apple')],
    ]);
    expect(diffStackStates(deletedFrom, new Map()).deleted).toEqual(['apple', 'zebra']);
  });
});
