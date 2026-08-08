/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { RelationshipType } from '@ifc-lite/data';
import {
  collectAggregatedDescendants,
  expandToGeometryBearingIds,
  getAggregatedChildren,
  hasAggregatedGeometry,
  type AggregationModelAccess,
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

/** Legacy single-model space: globalId === expressId. */
const identity = (expressId: number) => expressId;

describe('hasAggregatedGeometry', () => {
  it('admits a geometry-less assembly whose parts render', () => {
    // 10 (assembly, no mesh) ─┬ 11 column (mesh)
    //                         └ 12 footing (mesh)
    const rel = makeRelationships({ 10: [11, 12] });
    assert.strictEqual(hasAggregatedGeometry(rel, 10, identity, new Set([11, 12])), true);
  });

  it('finds geometry nested more than one level down', () => {
    const rel = makeRelationships({ 10: [11], 11: [12] });
    assert.strictEqual(hasAggregatedGeometry(rel, 10, identity, new Set([12])), true);
  });

  it('rejects a container with no geometry and no renderable parts', () => {
    const rel = makeRelationships({ 10: [11] });
    assert.strictEqual(hasAggregatedGeometry(rel, 10, identity, new Set([99])), false);
    // Truly empty: no geometry, no parts at all.
    assert.strictEqual(hasAggregatedGeometry(rel, 13, identity, new Set([99])), false);
  });

  it('accepts an entity that renders under its own id, graph or not', () => {
    assert.strictEqual(hasAggregatedGeometry(undefined, 14, identity, new Set([14])), true);
    assert.strictEqual(hasAggregatedGeometry(undefined, 14, identity, new Set([15])), false);
  });

  it('terminates on a malformed aggregation cycle', () => {
    const rel = makeRelationships({ 10: [11], 11: [10] });
    assert.strictEqual(hasAggregatedGeometry(rel, 10, identity, new Set([99])), false);
  });

  it('memoises so a whole-model scan does not re-walk shared subtrees', () => {
    let calls = 0;
    const adjacency: Record<number, number[]> = { 10: [11, 12] };
    const rel: AggregationRelationships = {
      getRelated(entityId, relType, direction) {
        if (relType !== RelationshipType.Aggregates || direction !== 'forward') return [];
        calls++;
        return adjacency[entityId] ?? [];
      },
    };
    const cache = new Map<number, boolean>();
    const geo = new Set([99]);
    assert.strictEqual(hasAggregatedGeometry(rel, 10, identity, geo, cache), false);
    const after = calls;
    assert.ok(after > 0, 'the first call walks the graph');
    assert.strictEqual(hasAggregatedGeometry(rel, 10, identity, geo, cache), false);
    assert.strictEqual(calls, after, 'the repeat is served from the cache');
  });
});

describe('expandToGeometryBearingIds', () => {
  /** Two federated models, offsets 0 and 1000. Model A: assembly 10 → parts
   *  11, 12 (both meshed). Model B: assembly 10 → part 11 (meshed). */
  const access: AggregationModelAccess = {
    resolve: (globalId) =>
      globalId >= 1000
        ? { modelId: 'B', expressId: globalId - 1000 }
        : { modelId: 'A', expressId: globalId },
    relationshipsFor: (modelId) =>
      modelId === 'A'
        ? makeRelationships({ 10: [11, 12] })
        : modelId === 'B'
          ? makeRelationships({ 10: [11] })
          : undefined,
    toGlobalId: (modelId, expressId) => (modelId === 'B' ? expressId + 1000 : expressId),
  };
  const meshed = new Set([11, 12, 14, 1011]);
  const hasGeometry = (id: number) => meshed.has(id);

  it('expands a geometry-less assembly into its meshed parts', () => {
    assert.deepStrictEqual(expandToGeometryBearingIds([10], hasGeometry, access), [11, 12]);
  });

  it('passes a meshed element through untouched, in order', () => {
    assert.deepStrictEqual(expandToGeometryBearingIds([14, 11], hasGeometry, access), [14, 11]);
  });

  it('drops an entity with neither geometry nor meshed parts', () => {
    assert.deepStrictEqual(expandToGeometryBearingIds([13], hasGeometry, access), []);
    assert.deepStrictEqual(expandToGeometryBearingIds([13, 14], hasGeometry, access), [14]);
  });

  it('resolves each id inside its own model, never across the federation', () => {
    // 1010 is model B's assembly; it must yield 1011, not model A's 11/12.
    assert.deepStrictEqual(expandToGeometryBearingIds([1010], hasGeometry, access), [1011]);
    assert.deepStrictEqual(expandToGeometryBearingIds([10, 1010], hasGeometry, access), [11, 12, 1011]);
  });

  it('dedups when an assembly and one of its parts are both selected', () => {
    assert.deepStrictEqual(expandToGeometryBearingIds([11, 10], hasGeometry, access), [11, 12]);
  });

  // frameSelection lives in a useImperativeHandle closure inside Viewport.tsx,
  // which has no test harness — the behaviour above is what's actually pinned.
  // This is only a guard against the wiring being silently dropped, so it
  // matches against comment-stripped source (a bare substring search would
  // happily match the prose explaining the call).
  it('is wired into Viewport.frameSelection', () => {
    const source = readFileSync(
      new URL('../components/viewer/Viewport.tsx', import.meta.url),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const frameSelection = source.slice(source.indexOf('frameSelection: () => {'));
    const body = frameSelection.slice(0, frameSelection.indexOf('frameClashRegion:'));
    assert.ok(body.length > 0, 'frameSelection body located');
    assert.ok(
      body.includes('expandToGeometryBearingIds('),
      'frameSelection must resolve geometry-less assemblies before giving up on bounds',
    );
  });
});
