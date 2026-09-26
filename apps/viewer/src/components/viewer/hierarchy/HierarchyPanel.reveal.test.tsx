/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { act } from 'react';
import { IfcTypeEnum } from '@ifc-lite/data';
import { cleanup, click, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { useViewerStore } from '@/store';
import { HierarchyPanel } from '../HierarchyPanel.js';

afterEach(cleanup);

/** One storey (express id 4) holding `wallExpressId`, under Project(1)/Site(2)/
 *  Building(3) — every id fits inside the model's own registered maxExpressId
 *  of 7, so two calls (one per federated model) stay independent without
 *  colliding with either model's own publication range. */
function buildStoreySpatialHierarchy(
  storeyName: string,
  elevation: number,
  wallExpressId: number,
) {
  const storey = { expressId: 4, type: IfcTypeEnum.IfcBuildingStorey, name: storeyName, children: [], elements: [wallExpressId] };
  const building = { expressId: 3, type: IfcTypeEnum.IfcBuilding, name: 'Building', children: [storey], elements: [] };
  const site = { expressId: 2, type: IfcTypeEnum.IfcSite, name: 'Site', children: [building], elements: [] };
  const project = { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'Project', children: [site], elements: [] };
  return {
    project,
    byStorey: new Map([[4, [wallExpressId]]]),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map([[4, elevation]]),
    storeyHeights: new Map(),
    elementToStorey: new Map([[wallExpressId, 4]]),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
  };
}

/** Two storeys (empty storey 4, storey 5 holding `wallExpressId`) under one
 *  Project/Site/Building — the single-model shape the search harness uses. */
function buildTwoStoreySpatialHierarchy(wallExpressId: number) {
  const secondStorey = { expressId: 5, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 2', children: [], elements: [wallExpressId] };
  const firstStorey = { expressId: 4, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 1', children: [], elements: [] };
  const building = { expressId: 3, type: IfcTypeEnum.IfcBuilding, name: 'Building', children: [firstStorey, secondStorey], elements: [] };
  const site = { expressId: 2, type: IfcTypeEnum.IfcSite, name: 'Site', children: [building], elements: [] };
  const project = { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'Project', children: [site], elements: [] };
  return {
    project,
    byStorey: new Map([[4, []], [5, [wallExpressId]]]),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map(),
    storeyHeights: new Map(),
    elementToStorey: new Map([[wallExpressId, 5]]),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
  };
}

function findRowByText(container: HTMLElement, text: string): Element | undefined {
  return [...container.querySelectorAll('.hierarchy-item')].find((el) => el.textContent?.includes(text));
}

function chevron(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  const el = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);
  return el instanceof HTMLButtonElement ? el : undefined;
}

describe('HierarchyPanel reveal selection (#5881)', () => {
  it('reveals and selects a wall chosen outside the tree (single model)', () => {
    const model = fixtureModel('reveal-single', { entities: [
      { expressId: 7, type: 'IfcWall', name: 'Target Wall' },
    ] });
    Object.assign(model.ifcDataStore!, { spatialHierarchy: buildTwoStoreySpatialHierarchy(7) });
    useViewerStore.setState({ ...fixtureModels(model), ifcDataStore: model.ifcDataStore, hierarchyMode: 'spatial', selectedEntityId: null, selectedEntityIds: new Set() });
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);

    // Fully collapsed: storey 2's chevron reads "Expand", the wall is off screen.
    assert.ok(chevron(container, 'Expand Storey 2'), 'storey 2 starts collapsed');
    assert.doesNotMatch(container.textContent ?? '', /Target Wall/);

    // A selection made outside the tree (unregistered model -> globalId === expressId).
    act(() => {
      useViewerStore.getState().setSelectedEntityId(7);
    });

    assert.match(container.textContent ?? '', /Target Wall/, 'reveal expands storey 2');
    const row = findRowByText(container, 'Target Wall');
    assert.ok(row, 'the wall row renders');
    assert.ok(row!.classList.contains('selected'), 'the wall row is marked selected');
  });

  it('reveals a federated wall in model 2 without touching model 1 (two models)', () => {
    const offsetA = useViewerStore.getState().registerModelOffset('reveal-fed-A', 7);
    const offsetB = useViewerStore.getState().registerModelOffset('reveal-fed-B', 7);
    const modelA = fixtureModel('reveal-fed-A', { idOffset: offsetA, entities: [
      { expressId: 7, type: 'IfcWall', name: 'Wall A' },
    ] });
    Object.assign(modelA.ifcDataStore!, { spatialHierarchy: buildStoreySpatialHierarchy('Storey A', 0, 7) });
    const modelB = fixtureModel('reveal-fed-B', { idOffset: offsetB, entities: [
      { expressId: 7, type: 'IfcWall', name: 'Target Wall B' },
    ] });
    Object.assign(modelB.ifcDataStore!, { spatialHierarchy: buildStoreySpatialHierarchy('Storey B', 100, 7) });
    useViewerStore.setState({ ...fixtureModels(modelA, modelB), hierarchyMode: 'spatial', selectedEntityId: null, selectedEntityIds: new Set() });
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);

    // Two sections render in multi-model mode: the unified Building Storeys
    // tree (reveal's target) and a separate, always-fully-expanded Models
    // browsing section (unrelated to this feature — it lists every element of
    // every model regardless of selection). Scope these assertions to the
    // Storeys section so the Models section's pre-existing full expansion
    // isn't mistaken for a reveal.
    const storeysSection = container.querySelector('.overflow-auto');
    assert.ok(storeysSection, 'storeys section renders');
    assert.doesNotMatch(storeysSection!.textContent ?? '', /Wall A|Target Wall B/, 'both unified storeys start collapsed');

    const wallBGlobalId = useViewerStore.getState().toGlobalId('reveal-fed-B', 7);
    act(() => {
      useViewerStore.getState().setSelectedEntityId(wallBGlobalId);
    });

    const rowB = findRowByText(storeysSection as HTMLElement, 'Target Wall B');
    assert.ok(rowB, 'model B\'s wall row renders in the Storeys section');
    assert.ok(rowB!.classList.contains('selected'), 'model B\'s wall row is selected');
    assert.doesNotMatch(storeysSection!.textContent ?? '', /Wall A/, 'model A\'s unified storey stays collapsed and unrevealed');
  });

  it('does not scroll on a tree-click selection, but does on an outside selection (#5881 guard)', () => {
    const model = fixtureModel('reveal-scroll', { entities: [
      { expressId: 6, type: 'IfcWall', name: 'Hidden Wall' },
      { expressId: 7, type: 'IfcWall', name: 'Visible Wall' },
    ] });
    const secondStorey = { expressId: 5, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 2', children: [], elements: [7] };
    const firstStorey = { expressId: 4, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 1', children: [], elements: [6] };
    const building = { expressId: 3, type: IfcTypeEnum.IfcBuilding, name: 'Building', children: [firstStorey, secondStorey], elements: [] };
    const site = { expressId: 2, type: IfcTypeEnum.IfcSite, name: 'Site', children: [building], elements: [] };
    const project = { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'Project', children: [site], elements: [] };
    Object.assign(model.ifcDataStore!, {
      spatialHierarchy: {
        project,
        byStorey: new Map([[4, [6]], [5, [7]]]),
        byBuilding: new Map(),
        bySite: new Map(),
        bySpace: new Map(),
        storeyElevations: new Map(),
        storeyHeights: new Map(),
        elementToStorey: new Map([[6, 4], [7, 5]]),
        getStoreyElements: () => [],
        getStoreyByElevation: () => null,
        getContainingSpace: () => null,
        getPath: () => [],
      },
    });
    useViewerStore.setState({ ...fixtureModels(model), ifcDataStore: model.ifcDataStore, hierarchyMode: 'spatial', selectedEntityId: null, selectedEntityIds: new Set() });
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);

    // Expand storey 2 (via a real chevron click) so "Visible Wall" is on screen,
    // and leave storey 1 ("Hidden Wall") collapsed.
    const expandStorey2 = chevron(container, 'Expand Storey 2');
    assert.ok(expandStorey2);
    click(expandStorey2!);
    assert.match(container.textContent ?? '', /Visible Wall/);
    assert.doesNotMatch(container.textContent ?? '', /Hidden Wall/);

    const scrollToCalls: unknown[][] = [];
    const originalScrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollToSpy(this: Element, ...args: unknown[]) {
      scrollToCalls.push(args);
      return undefined;
    } as typeof Element.prototype.scrollTo;

    try {
      // The tree's own click selects "Visible Wall" — it is already on
      // screen, so the reveal guard must suppress the scroll.
      const visibleRow = findRowByText(container, 'Visible Wall');
      assert.ok(visibleRow);
      click(visibleRow!);
      assert.equal(useViewerStore.getState().selectedEntityId, 7, 'the click did select the wall');
      assert.equal(scrollToCalls.length, 0, 'a tree click must not trigger the reveal scroll');

      // Re-clicking the selected row leaves selectedEntityId unchanged. The
      // following outside selection must still be revealed.
      click(visibleRow!);
      assert.equal(useViewerStore.getState().selectedEntityId, 7);

      // Positive control: a selection from OUTSIDE the tree, on a currently
      // hidden element, must scroll.
      act(() => {
        useViewerStore.getState().setSelectedEntityId(6);
      });
      assert.match(container.textContent ?? '', /Hidden Wall/, 'the outside selection reveals storey 1');
      assert.ok(scrollToCalls.length > 0, 'an outside selection on a hidden row must scroll');
    } finally {
      Element.prototype.scrollTo = originalScrollTo;
    }
  });

  it('reveals an outside re-selection after a same-id repeat click and a deselect (adversarial review, #6133)', () => {
    // Reproduces the reviewer's failing sequence: click row 7, click row 7
    // again (selectedEntityId never changes, so the OLD id-keyed guard never
    // got a chance to clear itself), collapse its storey, deselect, then
    // re-select 7 from "the viewport". A stale click-guard mark must not
    // survive the deselect and falsely mask this outside re-selection.
    const model = fixtureModel('reveal-repeat', { entities: [
      { expressId: 7, type: 'IfcWall', name: 'Repeat Wall' },
    ] });
    Object.assign(model.ifcDataStore!, { spatialHierarchy: buildTwoStoreySpatialHierarchy(7) });
    useViewerStore.setState({ ...fixtureModels(model), ifcDataStore: model.ifcDataStore, hierarchyMode: 'spatial', selectedEntityId: null, selectedEntityIds: new Set() });
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);

    const expandStorey2 = chevron(container, 'Expand Storey 2');
    assert.ok(expandStorey2);
    click(expandStorey2!);
    const row = findRowByText(container, 'Repeat Wall');
    assert.ok(row);

    click(row!); // tree click #1: selects 7
    assert.equal(useViewerStore.getState().selectedEntityId, 7);
    click(row!); // tree click #2: repeat click, selectedEntityId stays 7
    assert.equal(useViewerStore.getState().selectedEntityId, 7);

    const collapseStorey2 = chevron(container, 'Collapse Storey 2');
    assert.ok(collapseStorey2, 'storey 2 is expanded after the clicks above');
    click(collapseStorey2!);
    assert.doesNotMatch(container.textContent ?? '', /Repeat Wall/, 'storey collapsed manually, row off screen');

    const scrollToCalls: unknown[][] = [];
    const originalScrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollToSpy(this: Element, ...args: unknown[]) {
      scrollToCalls.push(args);
      return undefined;
    } as typeof Element.prototype.scrollTo;

    try {
      act(() => { useViewerStore.getState().setSelectedEntityId(null); }); // outside deselect
      act(() => { useViewerStore.getState().setSelectedEntityId(7); }); // outside re-select, same id the tree last clicked

      assert.match(container.textContent ?? '', /Repeat Wall/, 'the outside re-selection re-expands the collapsed storey');
      const revealedRow = findRowByText(container, 'Repeat Wall');
      assert.ok(revealedRow, 'the wall row renders again');
      assert.ok(revealedRow!.classList.contains('selected'), 'the row is marked selected');
      assert.ok(scrollToCalls.length > 0, 'the outside re-selection scrolls the row into view');
    } finally {
      Element.prototype.scrollTo = originalScrollTo;
    }
  });

  it('re-reveals a held selection when the grouping tab switches (#5881 should-fix)', () => {
    const model = fixtureModel('reveal-grouping-switch', { entities: [
      { expressId: 7, type: 'IfcWall', name: 'Switch Wall' },
    ] });
    Object.assign(model.ifcDataStore!, { spatialHierarchy: buildTwoStoreySpatialHierarchy(7) });
    useViewerStore.setState({ ...fixtureModels(model), ifcDataStore: model.ifcDataStore, hierarchyMode: 'spatial', selectedEntityId: null, selectedEntityIds: new Set() });
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);

    act(() => { useViewerStore.getState().setSelectedEntityId(7); });
    assert.match(container.textContent ?? '', /Switch Wall/, 'revealed under the spatial grouping');

    act(() => { useViewerStore.getState().setHierarchyMode('type'); }); // switch to the "By Class" tab

    assert.match(container.textContent ?? '', /Switch Wall/, 'the held selection is re-revealed under the By Class grouping');
    const row = findRowByText(container, 'Switch Wall');
    assert.ok(row, 'the wall row renders in the new grouping');
    assert.ok(row!.classList.contains('selected'), 'the row is still marked selected');
  });
});
