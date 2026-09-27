/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An element authored this session lives only in the mutation overlay, so the
 * parsed entity table answers 'Unknown' for its id. The context menu header
 * read that table and titled a freshly added wall "Unknown #<id>" (#6233); it
 * must show the authored Name and class, and a later rename, like the
 * Inspector and the Hierarchy tree do.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { EntityContextMenu } from './EntityContextMenu.js';
import { parseFixtureModel, FIXTURE_WALL_A } from './anonymized-export/anonymized-export-fixture.test-support.js';

const ID_OFFSET = 1_000_000;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<EntityContextMenu />); });
  mounted.push({ root, container });
  return container;
}
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}
after(unmountAll);

/** The header's title and class lines. */
function header(): { title: string; type: string } {
  render();
  const title = document.body.querySelector('.font-medium.text-sm.truncate');
  const type = title?.nextElementSibling;
  assert.ok(title && type, 'the context menu header is rendered');
  return { title: title.textContent ?? '', type: type.textContent ?? '' };
}

let view: MutablePropertyView;
beforeEach(async () => {
  unmountAll();
  act(() => { useViewerStore.getState().closeContextMenu(); });
  const store = await parseFixtureModel();
  view = new MutablePropertyView(null, 'm1');
  view.setExpressIdWatermark(1000);
  useViewerStore.setState({
    models: new Map([['m1', {
      id: 'm1', name: 'm1.ifc', ifcDataStore: store, geometryResult: null, visible: true, collapsed: false,
      schemaVersion: 'IFC4', loadedAt: 1, fileSize: 0, idOffset: ID_OFFSET, maxExpressId: 100_000,
    } as FederatedModel]]),
    mutationViews: new Map([['m1', view]]),
    storeEditors: new Map(), undoStacks: new Map(), dirtyModels: new Set(),
    collabRole: null, editEnabled: false,
  });
});

describe('EntityContextMenu header for an element authored this session (#6233)', () => {
  it('shows the authored Name and class, not "Unknown"', () => {
    const wall = view.createEntity('IfcWall', ['0Authored0000000000001', null, 'Authored Wall']);
    act(() => { useViewerStore.getState().openContextMenu(wall.expressId + ID_OFFSET, 10, 10); });
    assert.deepEqual(header(), { title: 'Authored Wall', type: 'IfcWall' });
  });

  it('an unnamed authored wall falls back to "<class> #<id>"', () => {
    const wall = view.createEntity('IfcWall', ['0Authored0000000000002', null, null]);
    const id = wall.expressId + ID_OFFSET;
    act(() => { useViewerStore.getState().openContextMenu(id, 10, 10); });
    assert.deepEqual(header(), { title: `IfcWall #${id}`, type: 'IfcWall' });
  });

  it('a parsed wall renamed this session shows its new Name', () => {
    view.setAttribute(FIXTURE_WALL_A, 'Name', 'Renamed Wall');
    act(() => { useViewerStore.getState().openContextMenu(FIXTURE_WALL_A + ID_OFFSET, 10, 10); });
    assert.equal(header().title, 'Renamed Wall');
  });
});
