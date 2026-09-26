/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `EntityContextMenu`'s "Select all <Type>" and "Select same storey" items
 * read `activeDataStore.entities` / `spatialHierarchy`, both model-space
 * (the right-clicked entity's OWN store), but must write their result into
 * `selectedEntityIds` — the renderer-space, offset-per-model channel every
 * other consumer (picking, `resolveEntityRef`, the renderer) treats as a
 * `globalId`. With a non-zero federation offset, writing the raw model-space
 * ids selects the WRONG entities (or none) once a second model is loaded.
 *
 * Uses the same federated single-model-with-offset fixture as
 * `EntityContextMenu.anonymized-export.test.tsx`.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store/index.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel } from '@/store/types.js';
import { EntityContextMenu } from './EntityContextMenu.js';
import {
  parseFixtureModel,
  FIXTURE_WALL_A,
  FIXTURE_WALL_B,
  FIXTURE_WALL_C,
  FIXTURE_WINDOW,
  guid,
} from './anonymized-export/anonymized-export-fixture.test-support.js';

const ID_OFFSET = 1_000_000;
const globalId = (localId: number): number => localId + ID_OFFSET;

function federatedModel(id: string, ifcDataStore: FederatedModel['ifcDataStore']): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: ID_OFFSET,
    maxExpressId: 100_000,
  } as FederatedModel;
}

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

function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(btn, `no menu item labelled "${label}"`);
  return btn as HTMLButtonElement;
}

beforeEach(async () => {
  unmountAll();
  const store = await parseFixtureModel();
  useViewerStore.setState({
    models: new Map([['m1', federatedModel('m1', store)]]),
    mutationViews: new Map(),
    selectedEntityIds: new Set<number>(),
    anonymizedExportRequested: false,
  });
});

describe('EntityContextMenu — federation-space selection', () => {
  it('"Select all IfcWall" resolves through the model offset', () => {
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();

    act(() => { menuItem(container, 'Select all IfcWall').click(); });

    const state = useViewerStore.getState();
    assert.deepEqual(
      state.selectedEntityIds,
      new Set([globalId(FIXTURE_WALL_A), globalId(FIXTURE_WALL_B), globalId(FIXTURE_WALL_C)]),
      'selectedEntityIds must carry renderer-space (offset) ids, not raw model-space expressIds',
    );
  });

  it('selects the live class after deletion, creation, and retype (#5249)', () => {
    const view = new MutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(88);
    view.deleteEntity(FIXTURE_WALL_C);
    view.setEntityType(FIXTURE_WALL_B, 'IfcDoor');
    view.setEntityType(FIXTURE_WINDOW, 'IfcWall');
    const created = view.createEntity('IfcWall', [guid(89), null, 'New Wall', null, null, null, null, null]);
    useViewerStore.setState({ mutationViews: new Map([['m1', view]]) });

    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();
    act(() => { menuItem(container, 'Select all IfcWall').click(); });

    assert.deepEqual(useViewerStore.getState().selectedEntityIds,
      new Set([globalId(FIXTURE_WALL_A), globalId(FIXTURE_WINDOW), globalId(created.expressId)]));

    act(() => { useViewerStore.getState().openContextMenu(globalId(created.expressId), 10, 10); });
    const createdMenu = render();
    act(() => { menuItem(createdMenu, 'Select all IfcWall').click(); });
    assert.deepEqual(useViewerStore.getState().selectedEntityIds,
      new Set([globalId(FIXTURE_WALL_A), globalId(FIXTURE_WINDOW), globalId(created.expressId)]));
  });

  it('reads the legacy mutation view when no federation model is registered (#5249)', () => {
    const store = useViewerStore.getState().models.get('m1')!.ifcDataStore!;
    const view = new MutablePropertyView(null, '__legacy__');
    view.setExpressIdWatermark(88);
    view.deleteEntity(FIXTURE_WALL_B);
    const created = view.createEntity('IfcWall', [guid(89), null, 'New Wall', null, null, null, null, null]);
    useViewerStore.setState({ models: new Map(), ifcDataStore: store,
      mutationViews: new Map([['__legacy__', view]]) });

    act(() => { useViewerStore.getState().openContextMenu(FIXTURE_WALL_A, 10, 10); });
    const container = render();
    act(() => { menuItem(container, 'Select all IfcWall').click(); });
    assert.deepEqual(useViewerStore.getState().selectedEntityIds,
      new Set([FIXTURE_WALL_A, FIXTURE_WALL_C, created.expressId]));
  });

  it('"Select same storey" resolves through the model offset', () => {
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_B), 10, 10); });
    const container = render();

    act(() => { menuItem(container, 'Select same storey').click(); });

    const state = useViewerStore.getState();
    assert.deepEqual(
      state.selectedEntityIds,
      new Set([globalId(FIXTURE_WALL_B), globalId(FIXTURE_WALL_C)]),
      'selectedEntityIds must carry renderer-space (offset) ids, not raw model-space expressIds',
    );
  });
});
