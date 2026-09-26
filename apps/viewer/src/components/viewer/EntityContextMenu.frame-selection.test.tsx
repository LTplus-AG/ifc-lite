/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `EntityContextMenu`'s camera item (#5597): it must frame the right-clicked
 * entity through `cameraCallbacks.frameSelection` — the callback F, the
 * toolbar and search use — not `fitAll`, which zooms to the whole model.
 * It also shows the shortcut hints the menu's `MenuItem` supports.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach, after, mock } from 'node:test';
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

/** The item whose label span reads `label` (the shortcut hint is a sibling span). */
function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => b.querySelector('span')?.textContent?.trim() === label,
  );
  assert.ok(btn, `no menu item labelled "${label}"`);
  return btn as HTMLButtonElement;
}

const fitAll = mock.fn();
const frameSelection = mock.fn(() => true);

beforeEach(async () => {
  unmountAll();
  fitAll.mock.resetCalls();
  frameSelection.mock.resetCalls();
  mock.timers.enable({ apis: ['setTimeout'] });
  const store = await parseFixtureModel();
  useViewerStore.setState({
    models: new Map([['m1', federatedModel('m1', store)]]),
    // A stale multi-selection: `frameSelection` prefers this set, so leaving
    // it would frame WALL_B instead of the right-clicked WALL_A.
    selectedEntityIds: new Set([globalId(FIXTURE_WALL_B)]),
    selectedEntityId: globalId(FIXTURE_WALL_B),
    cameraCallbacks: { fitAll, frameSelection },
  });
});
afterEach(() => mock.timers.reset());

describe('EntityContextMenu — Frame selection (#5597)', () => {
  it('frames the right-clicked entity via frameSelection, not fitAll', () => {
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();

    act(() => { menuItem(container, 'Frame selection').click(); });
    mock.timers.tick(50);

    assert.equal(frameSelection.mock.callCount(), 1, 'frameSelection must run once');
    assert.equal(fitAll.mock.callCount(), 0, 'fitAll zooms to the whole model');
    const state = useViewerStore.getState();
    assert.equal(state.selectedEntityId, globalId(FIXTURE_WALL_A));
    assert.equal(state.selectedEntityIds.size, 0, 'stale multi-selection must be cleared before framing');
    assert.equal(state.contextMenu.isOpen, false);
  });

  it('shows the keyboard hints of the items that have a shortcut', () => {
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();
    const hints: Array<[string, string]> = [
      ['Frame selection', 'F'],
      ['Hide', 'Del'],
      ['Set Collection', '='],
      ['Add to Collection', '+'],
      ['Remove from Collection', '−'],
      ['Save Collection View', 'B'],
    ];
    for (const [label, key] of hints) {
      const hint = menuItem(container, label).querySelectorAll('span')[1];
      assert.equal(hint?.textContent, key, `"${label}" shortcut hint`);
    }
  });

  it('shows the A hint on the canvas menu\'s "Show all"', () => {
    act(() => { useViewerStore.getState().openContextMenu(null, 10, 10); });
    const container = render();
    assert.equal(menuItem(container, 'Show all').querySelectorAll('span')[1]?.textContent, 'A');
  });
});
