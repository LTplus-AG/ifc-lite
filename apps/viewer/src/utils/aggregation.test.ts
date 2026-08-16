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

  it('does not call getRelated at all for an entity that decomposes nothing', () => {
    // The vast majority of a whole-model scan (property sets, relationship
    // objects, ordinary non-decomposing elements) fails the own-geometry test
    // and has zero aggregation children — that path must cost exactly the one
    // children lookup, never a second `getRelated` for "grandchildren" of an
    // empty children list, and it must not throw building a Set/stack it
    // never needs.
    let calls = 0;
    const rel: AggregationRelationships = {
      getRelated(entityId, relType, direction) {
        if (relType !== RelationshipType.Aggregates || direction !== 'forward') return [];
        calls++;
        return [];
      },
    };
    assert.strictEqual(hasAggregatedGeometry(rel, 42, identity, new Set([99])), false);
    assert.strictEqual(calls, 1, 'exactly one getRelated call — for the (empty) children of the root');
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

  // frameSelection and resolveHighlightIds live in a useImperativeHandle
  // closure inside Viewport.tsx, which has no test harness (no DOM/renderer
  // to mount against) — the behaviour above, on the pure function both of
  // them delegate to, is what's actually pinned. This is only a guard
  // against the wiring being silently dropped or one of the two callbacks
  // being pointed at a DIFFERENT resolution than the other (the actual bug:
  // frameSelection resolved geometry-less assemblies to their renderable
  // parts, but nothing told the renderer's highlight channel — see
  // SearchModal.text.tsx below), so it matches against comment-stripped
  // source. A bare substring search for `expandToGeometryBearingIds(` would
  // happily match either callback alone, or the prose explaining the call —
  // this additionally requires BOTH callbacks route through the SAME shared
  // helper, which is what actually closes the highlight/frame mismatch.
  it('frameSelection and resolveHighlightIds share the same aggregation resolution', () => {
    const source = readFileSync(
      new URL('../components/viewer/Viewport.tsx', import.meta.url),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const helperStart = source.indexOf('const resolveRenderableIds = ');
    assert.ok(helperStart >= 0, 'resolveRenderableIds helper defined');
    const helperBody = source.slice(helperStart, source.indexOf('setCameraCallbacks({', helperStart));
    assert.ok(
      helperBody.includes('expandToGeometryBearingIds('),
      'the shared helper must resolve geometry-less assemblies to their renderable parts',
    );

    const frameSelection = source.slice(source.indexOf('frameSelection: () => {'));
    const frameBody = frameSelection.slice(0, frameSelection.indexOf('resolveHighlightIds:'));
    assert.ok(
      frameBody.includes('resolveRenderableIds('),
      'frameSelection must resolve geometry-less assemblies before giving up on bounds',
    );

    const resolveHighlight = frameSelection.slice(frameSelection.indexOf('resolveHighlightIds:'));
    const highlightBody = resolveHighlight.slice(0, resolveHighlight.indexOf('frameClashRegion:'));
    assert.ok(
      highlightBody.includes('resolveRenderableIds('),
      'resolveHighlightIds must use the SAME resolution as frameSelection, not a separate one',
    );
  });

  // Same no-harness constraint, second property: HOW that shared resolution
  // asks for bounds. `resolveRenderableIds` decides `hasGeometry` for every
  // input id AND every aggregated descendant, so a per-id `getEntityBounds`
  // (a full scan of the mesh array, per call) makes one isolate O(ids ×
  // meshes). It must read through the self-indexing lookup instead — and it
  // must keep the renderer's per-occurrence fallback, because GPU-instanced
  // occurrences are not in the mesh array at all and would otherwise every one
  // of them read as geometry-less and get dropped or wrongly expanded.
  // Behaviour of the lookup itself is pinned in unionEntityBounds.test.ts.
  it('the shared bounds lookup is indexed and keeps the instanced fallback', () => {
    const source = readFileSync(
      new URL('../components/viewer/Viewport.tsx', import.meta.url),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const start = source.indexOf('const createRenderableBoundsLookup = ');
    assert.ok(start >= 0, 'the shared bounds lookup helper is defined');
    // Assert the END marker too. `indexOf` returns -1 when it is gone, and
    // `slice(start, -1)` silently runs to the end of the FILE instead of
    // failing — the assertions below would then be inspecting most of
    // Viewport.tsx rather than this helper, and would pass or fail on
    // unrelated code. A source-text guard that can address the wrong region
    // is worse than none, because it still reports green.
    const end = source.indexOf('const resolveRenderableIds = ', start);
    assert.ok(end >= 0, 'resolveRenderableIds follows the lookup helper');
    const body = source.slice(start, end);

    assert.ok(
      body.includes('createEntityBoundsLookup('),
      'bounds must come from the self-indexing reader, not a per-id getEntityBounds scan',
    );
    assert.ok(
      body.includes('getInstancedEntityBounds('),
      'instanced occurrences live outside the mesh array — the fallback must stay',
    );

    const helperStart2 = source.indexOf('const resolveRenderableIds = ');
    assert.ok(helperStart2 >= 0, 'resolveRenderableIds is defined');
    const helperEnd2 = source.indexOf('setCameraCallbacks({', helperStart2);
    assert.ok(helperEnd2 >= 0, 'setCameraCallbacks bounds the helper');
    const helperBody2 = source.slice(helperStart2, helperEnd2);
    assert.ok(
      !helperBody2.includes('getEntityBounds('),
      'resolveRenderableIds must not scan the mesh array per id',
    );
  });

  // The other half of the fix — a selection entry point that assigns
  // selectedEntityId/selectedEntityIds directly (not via a 3D pick, which can
  // never land on a geometry-less assembly) must resolve through
  // resolveHighlightIds before highlighting, or the camera moves to an
  // assembly that stays dark — is covered behaviourally, not by source text,
  // in SearchModal.text.wiring.test.tsx ("resolves through resolveHighlightIds
  // and puts the clicked id LAST, so it stays primary"): it stubs
  // cameraCallbacks.resolveHighlightIds, clicks a real rendered row, and reads
  // the resulting selectedEntityIds/selectedEntityId off the store, which is
  // strictly stronger than grepping commit()'s source for both the call and
  // its position.
});
