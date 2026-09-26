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
import { cleanup, click, render, type } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { useViewerStore } from '@/store';
import { HierarchyPanel } from '../HierarchyPanel.js';

afterEach(cleanup);

function mountHierarchy(withPart = false): { container: HTMLElement; input: HTMLInputElement } {
  const model = fixtureModel('search-model', { entities: [
    { expressId: 7, type: 'IfcWall', name: 'Target Wall' },
    ...(withPart ? [{ expressId: 8, type: 'IfcBuildingElementPart', name: 'Hidden Part' }] : []),
  ] });
  const secondStorey = { expressId: 5, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 2', children: [], elements: withPart ? [7, 8] : [7] };
  const firstStorey = { expressId: 4, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 1', children: [], elements: [] };
  const building = { expressId: 3, type: IfcTypeEnum.IfcBuilding, name: 'Building', children: [firstStorey, secondStorey], elements: [] };
  const site = { expressId: 2, type: IfcTypeEnum.IfcSite, name: 'Site', children: [building], elements: [] };
  const project = { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'Project', children: [site], elements: [] };
  Object.assign(model.ifcDataStore!, {
      spatialHierarchy: {
        project,
        byStorey: new Map([[4, []], [5, withPart ? [7, 8] : [7]]]),
        byBuilding: new Map(),
        bySite: new Map(),
        bySpace: new Map(),
        storeyElevations: new Map(),
        storeyHeights: new Map(),
        elementToStorey: new Map(withPart ? [[7, 5], [8, 5]] : [[7, 5]]),
        getStoreyElements: () => [],
        getStoreyByElevation: () => null,
        getContainingSpace: () => null,
        getPath: () => [],
      },
  });
  useViewerStore.setState({ ...fixtureModels(model), ifcDataStore: model.ifcDataStore, hierarchyMode: 'spatial', mergeLayers: withPart });
  const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  const input = container.querySelector('input[placeholder="Search..."]');
  assert.ok(input instanceof HTMLInputElement);
  return { container, input };
}

describe('HierarchyPanel search (#5880)', () => {
  it('shows a clearable empty state for a query with no matches', () => {
    const { container, input } = mountHierarchy();
    type(input, 'absent wall');
    assert.match(container.textContent ?? '', /No matches for “absent wall”/);

    const clear = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Clear search');
    assert.ok(clear);
    click(clear);
    assert.equal(input.value, '');
    assert.doesNotMatch(container.textContent ?? '', /No matches for/);
  });

  it('finds a wall under a collapsed storey and restores that collapse after clearing', () => {
    const { container, input } = mountHierarchy();
    assert.ok([...container.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Expand Storey 2'));
    assert.doesNotMatch(container.textContent ?? '', /Target Wall/);

    type(input, 'Target Wall');
    assert.match(container.textContent ?? '', /Storey 2/);
    assert.match(container.textContent ?? '', /Target Wall/);
    const searchChevron = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Collapse Storey 2');
    assert.ok(searchChevron);
    assert.equal(searchChevron.disabled, true);
    type(input, '');
    assert.doesNotMatch(container.textContent ?? '', /Target Wall/);
    assert.ok([...container.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Expand Storey 2'));
  });

  it('shows no matches when merged layers hide the only matching part', () => {
    const { container, input } = mountHierarchy(true);
    type(input, 'Hidden Part');
    assert.match(container.textContent ?? '', /No matches for “Hidden Part”/);
    assert.doesNotMatch(container.textContent ?? '', /Storey 2/);

    act(() => useViewerStore.setState({ mergeLayers: false }));
    assert.match(container.textContent ?? '', /Hidden Part/);
    assert.doesNotMatch(container.textContent ?? '', /No matches for/);
  });
});
