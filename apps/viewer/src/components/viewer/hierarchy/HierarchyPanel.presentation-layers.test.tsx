/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { cleanup, click, render, type, waitFor } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { useViewerStore } from '@/store';
import { HierarchyPanel } from '../HierarchyPanel.js';

afterEach(cleanup);

// #7619: parsed STEP ownership, rather than a mocked layer resolver, exercises
// the entire tab -> tree -> product selection and visibility action path.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('layers.ifc','2026-10-15T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0GUID000000000000000001',$,'Project',$,$,$,$,$,$);
#7=IFCWALL('0GUID000000000000000007',$,'Layer wall',$,$,$,#20,$);
#8=IFCWALL('0GUID000000000000000008',$,'Other wall',$,$,$,#30,$);
#20=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));
#21=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#22));
#22=IFCEXTRUDEDAREASOLID($,$,$,1.);
#30=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));
#31=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#32));
#32=IFCEXTRUDEDAREASOLID($,$,$,1.);
#50=IFCPRESENTATIONLAYERASSIGNMENT('Walls',$,(#21),$);
#51=IFCPRESENTATIONLAYERASSIGNMENT('Elsewhere',$,(#32),$);
ENDSEC;
END-ISO-10303-21;`;

function geometry(ids: number[]): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  return {
    meshes: ids.map(expressId => ({ expressId, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] })),
    totalTriangles: ids.length, totalVertices: ids.length * 3,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds,
      shiftedBounds: bounds, hasLargeCoordinates: false },
  };
}

async function model(id: string, federated = false, space = false) {
  const content = space ? IFC.replace("#7=IFCWALL(", "#7=IFCSPACE(") : IFC;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(content).buffer);
  const offset = federated ? useViewerStore.getState().registerModelOffset(id, 51) : 0;
  return { ...fixtureModel(id, { idOffset: offset }), ifcDataStore: store,
    geometryResult: geometry([offset + 7, offset + 8]) };
}

function mountPanel(models: Awaited<ReturnType<typeof model>>[], selectedId: number | null = null) {
  useViewerStore.setState({ ...fixtureModels(...models), ifcDataStore: models[0].ifcDataStore,
    hierarchyMode: 'spatial', selectedEntityId: selectedId, selectedEntityIds: new Set(selectedId == null ? [] : [selectedId]),
    hiddenEntities: new Set(), isolatedEntities: null, mutationViews: new Map(),
    mergeLayers: false, classFilter: null, selectedStoreys: new Set() });
  const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  const tab = [...container.querySelectorAll('button')].find(b => b.title === 'Presentation layers');
  assert.ok(tab, 'the dedicated Layers tab is accessible by its presentation-layer tooltip');
  click(tab);
  return container;
}

async function mount(...models: Awaited<ReturnType<typeof model>>[]): Promise<HTMLElement> {
  const container = mountPanel(models);
  await waitFor(() => layerRows(container).length > 0 || /No presentation layers/.test(container.textContent ?? ''),
    'the lazy layer tree or its genuine empty state appears');
  return container;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label);
  assert.ok(found, `button ${label} exists`);
  return found;
}

function layerRows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .filter(row => row.querySelector('button[aria-label="Expand Walls"],button[aria-label="Collapse Walls"]'));
}

describe('Presentation layers hierarchy (#7619)', () => {
  it('reveals a held selection after the first lazy Layers load, without flashing an empty state', async () => {
    const container = mountPanel([await model('presentation-cold-selected')], 7);
    assert.ok(container.querySelector('[role="tree"][aria-busy="true"]'));
    assert.match(container.textContent ?? '', /Loading presentation layers/);
    assert.doesNotMatch(container.textContent ?? '', /No presentation layers|No matches for/);
    const spatial = container.querySelector<HTMLButtonElement>('button[title="Spatial"]');
    const layers = container.querySelector<HTMLButtonElement>('button[title="Presentation layers"]');
    assert.ok(spatial && layers);
    click(spatial);
    assert.doesNotMatch(container.textContent ?? '', /Loading presentation layers/,
      'leaving the tab cancels its active loading UI');
    click(layers);
    await waitFor(() => !!container.querySelector('button[aria-label="Collapse Walls"]'),
      'lazy readiness re-reveals the held product selection');
    const product = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find(row => row.textContent?.includes('Layer wall'));
    assert.ok(product);
    assert.equal(product.getAttribute('aria-selected'), 'true');
    assert.equal(container.querySelector('[role="tree"]')?.getAttribute('aria-busy'), 'false');
  });

  it('selects products, hides/shows and isolates layer geometry, and searches collapsed members', async () => {
    const container = await mount(await model('presentation-single'));
    const row = layerRows(container)[0];
    assert.ok(row);
    assert.doesNotMatch(container.textContent ?? '', /Layer wall/);
    click(row);
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([7]));
    assert.equal(useViewerStore.getState().isolatedEntities, null);
    assert.equal(row.querySelector('button[aria-label="Filter by this Walls"]'), null);
    click(button(row, 'Hide Walls'));
    assert.ok(useViewerStore.getState().hiddenEntities.has(7));
    assert.ok(!useViewerStore.getState().hiddenEntities.has(8));
    click(button(row, 'Show Walls'));
    assert.ok(!useViewerStore.getState().hiddenEntities.has(7));
    click(button(row, 'Isolate Walls'));
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([7]));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search hierarchy"]');
    assert.ok(input);
    type(input, 'Layer wall');
    assert.match(container.textContent ?? '', /Layer wall/);
    assert.doesNotMatch(container.textContent ?? '', /Other wall/);
    type(input, '');
    assert.doesNotMatch(container.textContent ?? '', /Layer wall/);
    act(() => {
      useViewerStore.getState().setSelectedEntityId(null);
      useViewerStore.getState().setSelectedEntityId(7);
    });
    assert.match(container.textContent ?? '', /Layer wall/, 'outside selection reveals the member');
  });

  it('keeps same-name assignments and colliding local product IDs independent in a federation', async () => {
    const a = await model('presentation-fed-A', true);
    const b = await model('presentation-fed-B', true);
    const container = await mount(a, b);
    const rows = layerRows(container);
    assert.equal(rows.length, 2);
    click(rows[1]);
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([b.idOffset + 7]));
    click(button(rows[1], 'Hide Walls'));
    assert.ok(useViewerStore.getState().hiddenEntities.has(b.idOffset + 7));
    assert.ok(!useViewerStore.getState().hiddenEntities.has(a.idOffset + 7));
  });

  it('enables default-hidden spaces when isolating their presentation layer', async () => {
    act(() => useViewerStore.setState({ typeVisibility: {
      ...useViewerStore.getState().typeVisibility, spaces: false,
    } }));
    const container = await mount(await model('presentation-space', false, true));
    const row = layerRows(container)[0];
    assert.ok(row);
    click(button(row, 'Isolate Walls'));
    assert.equal(useViewerStore.getState().typeVisibility.spaces, true);
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([7]));
  });

  it('shows an explicit empty state when no assignments exist', async () => {
    const empty = await model('presentation-empty');
    empty.ifcDataStore = await new IfcParser().parseColumnar(new TextEncoder()
      .encode(IFC.replace(/^#5[01]=.*\n/gm, '')).buffer);
    const container = await mount(empty);
    assert.match(container.textContent ?? '', /No presentation layers/);
  });
});
