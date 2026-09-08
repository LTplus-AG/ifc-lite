/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `EntityContextMenu`'s "Export anonymized…" item (#2934): sets
 * `anonymizedExportRequested` — the flag `AnonymizedExportDialog` (mounted
 * trigger-less in `ViewerLayout.tsx`) watches — and makes sure the
 * right-clicked entity is part of `selectedEntityIds`, the channel
 * `useAnonymizedExportSet` seeds from (`apps/viewer/AGENTS.md` "Selection
 * has two channels").
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { EntityContextMenu } from './EntityContextMenu.js';
import { parseFixtureModel, FIXTURE_WALL_A, FIXTURE_WALL_B } from './anonymized-export/anonymized-export-fixture.test-support.js';

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
    selectedEntityIds: new Set<number>(),
    anonymizedExportRequested: false,
  });
});

describe('EntityContextMenu — Export anonymized…', () => {
  it('right-clicking an entity outside the current selection replaces it as the sole seed', () => {
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();

    act(() => { menuItem(container, 'Export anonymized…').click(); });

    const state = useViewerStore.getState();
    assert.deepEqual(state.selectedEntityIds, new Set([globalId(FIXTURE_WALL_A)]));
    assert.equal(state.anonymizedExportRequested, true);
    assert.equal(state.contextMenu.isOpen, false, 'the context menu must close');
  });

  it('right-clicking an entity ALREADY in a multi-selection keeps the whole selection as seeds', () => {
    const selection = new Set([globalId(FIXTURE_WALL_A), globalId(FIXTURE_WALL_B)]);
    useViewerStore.setState({ selectedEntityIds: selection });
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();

    act(() => { menuItem(container, 'Export anonymized…').click(); });

    const state = useViewerStore.getState();
    assert.deepEqual(state.selectedEntityIds, selection, 'must not narrow an existing multi-selection');
    assert.equal(state.anonymizedExportRequested, true);
  });
});
