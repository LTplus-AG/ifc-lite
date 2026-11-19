/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10535: a placement edit on a loaded tower rebuilt the tree and re-rendered
 * every visible row, and each panel render re-resolved every storey's
 * membership. Unchanged rows keep their objects, and a row's elements are
 * resolved once per input generation.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shareUnchangedNodes } from './sharedTreeNodes';
import { createNodeElementsResolver, type NodeElementsInputs } from './nodeElements';
import type { TreeNode, UnifiedStorey } from './types';

function row(id: string, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    id, expressIds: [1], globalIds: [1], modelIds: ['m'], name: id, type: 'IfcBuildingStorey',
    depth: 0, hasChildren: true, isExpanded: false, isVisible: true,
    countSummary: { counted: 3, rows: 4, typeCounts: [['IfcColumn', 3]], withoutGeometry: 0, spacesNotCounted: 0, geometryKnown: true },
    ...extra,
  };
}

describe('shareUnchangedNodes (#10535)', () => {
  it('returns the previous array when a rebuild produced equal rows', () => {
    const previous = [row('a'), row('b')];
    const rebuilt = [row('a'), row('b')];
    assert.equal(shareUnchangedNodes(previous, rebuilt), previous);
  });

  it('keeps unchanged row objects and takes changed ones', () => {
    const previous = [row('a'), row('b'), row('c')];
    const next = shareUnchangedNodes(previous, [row('a'), row('b', { name: 'renamed' }), row('c', { isExpanded: true })]);
    assert.notEqual(next, previous);
    assert.equal(next[0], previous[0]);
    assert.equal(next[1].name, 'renamed');
    assert.notEqual(next[1], previous[1]);
    assert.equal(next[2].isExpanded, true);
  });

  it('compares nested data: a changed count breakdown is a changed row', () => {
    const previous = [row('a')];
    const changed = row('a', { countSummary: { counted: 3, rows: 4, typeCounts: [['IfcColumn', 2], ['IfcWall', 1]], withoutGeometry: 0, spacesNotCounted: 0, geometryKnown: true } });
    assert.equal(shareUnchangedNodes(previous, [changed])[0], changed);
    assert.equal(shareUnchangedNodes(previous, [row('a', { globalIds: [1, 2] })])[0].globalIds.length, 2);
  });

  it('a reordered or shortened list is a new array that still reuses rows', () => {
    const previous = [row('a'), row('b')];
    const reordered = shareUnchangedNodes(previous, [row('b'), row('a')]);
    assert.notEqual(reordered, previous);
    assert.deepEqual(reordered.map((n) => n.id), ['b', 'a']);
    assert.equal(reordered[0], previous[1]);
    const shortened = shareUnchangedNodes(previous, [row('a')]);
    assert.notEqual(shortened, previous);
    assert.equal(shortened[0], previous[0]);
  });
});

describe('createNodeElementsResolver (#10535)', () => {
  const storey: UnifiedStorey = {
    key: 'k', name: 'L1', elevation: 0, storeys: [], totalElements: 2,
    objects: { counted: 2, rows: 2, typeCounts: [], withoutGeometry: 0, spacesNotCounted: 0, geometryKnown: true },
  };
  function inputs(resolveStorey: () => number[]): NodeElementsInputs {
    return {
      models: new Map(), ifcDataStore: null, unifiedStoreys: [storey], mutationViews: new Map(),
      getUnifiedStoreyElements: resolveStorey, toGlobalIdsForModel: (_m, ids) => ids,
    };
  }
  const unifiedRow = row('unified-k', { type: 'unified-storey', globalIds: [] });

  it('resolves a storey row once per generation, however often a render asks', () => {
    let resolutions = 0;
    const resolve = createNodeElementsResolver(inputs(() => { resolutions++; return [10, 11]; }));
    const first = resolve(unifiedRow);
    assert.deepEqual(first, [10, 11]);
    assert.equal(resolve(unifiedRow), first);
    assert.equal(resolve(row('unified-k', { type: 'unified-storey', globalIds: [] })), first, 'an equal row from a rebuild shares the answer');
    assert.equal(resolutions, 1);
  });

  it('a new generation resolves again, so an edit that changes membership is seen', () => {
    let members = [10];
    const resolveStorey = () => members;
    assert.deepEqual(createNodeElementsResolver(inputs(resolveStorey))(unifiedRow), [10]);
    members = [10, 12];
    assert.deepEqual(createNodeElementsResolver(inputs(resolveStorey))(unifiedRow), [10, 12]);
  });

  it('rows that carry their elements read them from the node, uncached', () => {
    const resolve = createNodeElementsResolver(inputs(() => { throw new Error('not a storey'); }));
    const group = row('type-IfcWall', { type: 'type-group', globalIds: [5, 6] });
    assert.equal(resolve(group), group.globalIds);
    assert.deepEqual(resolve(row('e', { type: 'element', globalIds: [7], assemblyChildGlobalIds: [8] })), [7, 8]);
  });
});
