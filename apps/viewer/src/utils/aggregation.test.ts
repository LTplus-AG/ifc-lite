/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RelationshipType } from '@ifc-lite/data';
import {
  collectAggregatedDescendants,
  getAggregatedChildren,
  type AggregationRelationships,
} from './aggregation';

/** Minimal forward-only IfcRelAggregates graph from an adjacency map. */
function makeRelationships(adjacency: Record<number, number[]>): AggregationRelationships {
  return {
    getRelated(entityId, relType, direction) {
      if (relType !== RelationshipType.Aggregates || direction !== 'forward') return [];
      return adjacency[entityId] ?? [];
    },
  };
}

describe('aggregation helpers', () => {
  it('getAggregatedChildren returns direct children only', () => {
    const rel = makeRelationships({ 1: [2, 3], 2: [4] });
    assert.deepStrictEqual(getAggregatedChildren(rel, 1), [2, 3]);
    assert.deepStrictEqual(getAggregatedChildren(rel, 2), [4]);
    assert.deepStrictEqual(getAggregatedChildren(rel, 4), []);
    assert.deepStrictEqual(getAggregatedChildren(undefined, 1), []);
  });

  it('collectAggregatedDescendants walks the whole subtree in pre-order, excluding the root', () => {
    // 1 ─┬ 2 ─ 4
    //    └ 3 ─┬ 5
    //         └ 6
    const rel = makeRelationships({ 1: [2, 3], 2: [4], 3: [5, 6] });
    assert.deepStrictEqual(collectAggregatedDescendants(rel, 1), [2, 4, 3, 5, 6]);
  });

  it('flat assembly (stair → 13 parts) returns every part', () => {
    const parts = [351, 561, 684, 757, 794, 821, 864, 879, 3111, 3140, 5276, 5302, 11299];
    const rel = makeRelationships({ 1124: parts });
    assert.deepStrictEqual(collectAggregatedDescendants(rel, 1124), parts);
  });

  it('terminates on a malformed aggregation cycle', () => {
    // A aggregates B, B aggregates A — must not loop forever.
    const rel = makeRelationships({ 1: [2], 2: [1] });
    assert.deepStrictEqual(collectAggregatedDescendants(rel, 1), [2]);
  });

  it('returns nothing for a leaf or a missing relationship graph', () => {
    const rel = makeRelationships({ 1: [2] });
    assert.deepStrictEqual(collectAggregatedDescendants(rel, 2), []);
    assert.deepStrictEqual(collectAggregatedDescendants(undefined, 1), []);
  });
});
