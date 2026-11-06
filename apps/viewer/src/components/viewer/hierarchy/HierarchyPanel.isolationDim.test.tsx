/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8802: rows wholly outside the viewport's isolation dim, so the tree shows
 * what the viewport draws. Storey Solo isolates through `selectedStoreys`, not
 * `isolatedEntities` (apps/viewer/AGENTS.md), so dimming must follow the
 * renderer's effective set (`useVisibilityIsolation`), or Solo's other storeys
 * stayed at full strength while absent from 3D.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { act } from 'react';
import { IfcTypeEnum } from '@ifc-lite/data';
import { cleanup, render } from '@/test/render.js';
import { fixtureModel, fixtureModels, fixtureDataStore } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { useViewerStore } from '@/store';
import { HierarchyPanel } from '../HierarchyPanel.js';
import { createSpatialSubtreeResolver, hierarchyNodeAppearance } from './nodeVisibility.js';
import { buildTreeData } from './treeDataBuilder.js';
import type { TreeNode } from './types.js';

afterEach(() => {
  cleanup();
  useViewerStore.setState({ selectedStoreys: new Set(), isolatedEntities: null, classFilter: null });
});

/** Project(1)/Site(2)/Building(3) with Storey 1 (4) holding wall 7 and
 *  Room (6), which holds desk 9, and Storey 2 (5) holding wall 8. */
function twoStoreyHierarchy() {
  const room = { expressId: 6, type: IfcTypeEnum.IfcSpace, name: 'Room', children: [], elements: [9] };
  const lower = { expressId: 4, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 1', children: [room], elements: [7] };
  const upper = { expressId: 5, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 2', children: [], elements: [8] };
  const building = { expressId: 3, type: IfcTypeEnum.IfcBuilding, name: 'Building', children: [lower, upper], elements: [] };
  const site = { expressId: 2, type: IfcTypeEnum.IfcSite, name: 'Site', children: [building], elements: [] };
  const project = { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'Project', children: [site], elements: [] };
  return {
    project,
    byStorey: new Map([[4, [7]], [5, [8]]]),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map([[6, [9]]]),
    storeyElevations: new Map([[4, 0], [5, 3]]),
    storeyHeights: new Map(),
    elementToStorey: new Map([[7, 4], [8, 5], [9, 4]]),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
  };
}

function rowDimmed(container: HTMLElement, text: string): boolean | null {
  const row = [...container.querySelectorAll('.hierarchy-item')].find((el) => el.textContent?.includes(text));
  return row ? row.className.split(/\s+/).includes('opacity-50') : null;
}

function mountPanel(): HTMLElement {
  const model = fixtureModel('isolation-dim', { entities: [
    { expressId: 7, type: 'IfcWall', name: 'Lower Wall' },
    { expressId: 8, type: 'IfcWall', name: 'Upper Wall' },
    { expressId: 6, type: 'IfcSpace', name: 'Room' },
    { expressId: 9, type: 'IfcFurniture', name: 'Desk' },
  ] });
  Object.assign(model.ifcDataStore!, { spatialHierarchy: twoStoreyHierarchy() });
  useViewerStore.setState({
    ...fixtureModels(model), ifcDataStore: model.ifcDataStore, hierarchyMode: 'spatial',
    selectedEntityId: null, selectedEntityIds: new Set(), hiddenEntities: new Set(),
    selectedStoreys: new Set(), isolatedEntities: null, classFilter: null,
  });
  return render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
}

describe('HierarchyPanel dims rows outside the viewport isolation (#8802)', () => {
  it('dims nothing while no isolation channel is active', () => {
    const container = mountPanel();
    assert.equal(rowDimmed(container, 'Storey 1'), false);
    assert.equal(rowDimmed(container, 'Storey 2'), false);
  });

  it('dims the other storeys under storey Solo (selectedStoreys)', () => {
    const container = mountPanel();
    act(() => {
      useViewerStore.setState({ selectedStoreys: new Set([5]) });
    });
    assert.equal(useViewerStore.getState().isolatedEntities, null, 'Solo does not use the isolatedEntities channel');
    assert.equal(rowDimmed(container, 'Storey 1'), true, 'a storey outside the solo storey dims');
    assert.equal(rowDimmed(container, 'Storey 2'), false, 'the solo storey stays at full strength');
    assert.equal(rowDimmed(container, 'Building'), false, 'a container of the solo storey stays at full strength');
  });

  it('still dims under manual isolation (isolatedEntities)', () => {
    const container = mountPanel();
    act(() => {
      useViewerStore.setState({ isolatedEntities: new Set([7]) });
    });
    assert.equal(rowDimmed(container, 'Storey 1'), false);
    assert.equal(rowDimmed(container, 'Storey 2'), true);
  });

  it('refreshes a cached storey subtree after an in-place space edit (#8802)', () => {
    const container = mountPanel();
    act(() => {
      useViewerStore.setState({ isolatedEntities: new Set([8]) });
    });
    assert.equal(rowDimmed(container, 'Storey 1'), true, 'warm the subtree cache before editing');
    const state = useViewerStore.getState();
    const hierarchy = state.ifcDataStore!.spatialHierarchy!;
    act(() => {
      hierarchy.bySpace.get(6)!.push(10);
      hierarchy.project!.children[0].children[0].children[0].children[0].elements.push(10);
      hierarchy.elementToStorey.set(10, 4);
      useViewerStore.setState({ mutationVersion: state.mutationVersion + 1 });
    });
    act(() => {
      useViewerStore.setState({ isolatedEntities: new Set([10]) });
    });
    assert.equal(rowDimmed(container, 'Storey 1'), false, 'the newly added element in Room keeps Storey 1 normal');
    assert.equal(rowDimmed(container, 'Storey 2'), true);
  });

  it('keeps a storey whose only isolated element sits in one of its spaces normal', () => {
    const container = mountPanel();
    act(() => {
      useViewerStore.setState({ isolatedEntities: new Set([9]) });
    });
    assert.equal(rowDimmed(container, 'Storey 1'), false, 'the desk in Room is inside Storey 1');
    assert.equal(rowDimmed(container, 'Storey 2'), true);
  });
});

describe('hierarchyNodeAppearance isolation dim', () => {
  const element = { id: 'e', type: 'element', expressIds: [1], globalIds: [1], modelIds: ['legacy'] } as unknown as TreeNode;
  const noSubtree = () => [];
  const dim = (node: TreeNode, elements: number[], isolation: Set<number> | null, subtree: () => readonly number[] = noSubtree) =>
    hierarchyNodeAppearance(node, elements, new Set(), isolation, subtree).outsideIsolation;

  it('is false with no isolation, or for a row with no elements', () => {
    assert.equal(dim(element, [1, 2], null), false);
    assert.equal(dim(element, [], new Set([1])), false);
  });

  it('is true only when every element is outside the allowlist', () => {
    assert.equal(dim(element, [1, 2], new Set([3])), true);
    assert.equal(dim(element, [1, 2], new Set([2])), false);
  });

  it('counts a storey row\'s spatial subtree, and resolves it only when the direct members are outside', () => {
    const storey = { ...element, id: 's', type: 'IfcBuildingStorey' } as TreeNode;
    let resolved = 0;
    const subtree = () => { resolved += 1; return [5, 9]; };
    assert.equal(dim(storey, [1], new Set([9]), subtree), false, 'an isolated element in the subtree keeps the storey normal');
    assert.equal(dim(storey, [], new Set([9]), subtree), false, 'a storey with only spaces is tested on its subtree');
    assert.equal(dim(storey, [], new Set([3]), subtree), true, 'a storey whose whole subtree is outside dims');
    assert.equal(resolved, 3);
    assert.equal(dim(storey, [1], new Set([1]), subtree), false);
    assert.equal(resolved, 3, 'an isolated direct member settles it without the subtree');
  });
});

// #8802: a spatial IfcSpace row must include parts of its contained assemblies.
describe('IfcSpace isolation subtree (#8802)', () => {
  it('keeps the room normal when only an aggregated child is isolated', () => {
    const store = fixtureDataStore([
      { expressId: 6, type: 'IfcSpace', name: 'Room' },
      { expressId: 9, type: 'IfcElementAssembly', name: 'Desk assembly' },
      { expressId: 10, type: 'IfcFurniture', name: 'Desk part' },
    ], { aggregates: { 9: [10] } });
    store.spatialHierarchy = twoStoreyHierarchy();
    const models = new Map();
    const nodes = buildTreeData(models, store,
      new Set(['root-1', 'root-1-2', 'root-1-2-3', 'root-1-2-3-4']), false, []);
    const room = nodes.find(node => node.type === 'IfcSpace');
    assert.ok(room, 'use the actual spatial tree row');
    const resolve = createSpatialSubtreeResolver(models, store);
    let calls = 0;
    const subtree = (node: TreeNode) => { calls++; return resolve(node); };
    const appearance = (isolated: number[]) =>
      hierarchyNodeAppearance(room, [6, 9], new Set(), new Set(isolated), subtree);
    assert.equal(appearance([9]).outsideIsolation, false);
    assert.equal(calls, 0, 'direct membership avoids traversal');
    assert.equal(appearance([10]).outsideIsolation, false, 'isolated aggregated part keeps Room normal');
    assert.equal(appearance([8]).outsideIsolation, true, 'unrelated isolation dims Room');
    assert.ok(resolve(room).includes(10));
    assert.strictEqual(resolve(room), resolve(room), 'subtree is cached per row');
  });
});
