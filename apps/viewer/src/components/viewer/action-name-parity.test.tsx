/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import type { FederatedModel } from '@/store/types';
import { registerLocale, setLocale } from '@/i18n';
import { ACTION_NAME_KEYS } from '@/lib/commands/action-names';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { useViewerStore } from '@/store';
import { cleanup, render, type as typeInto } from '@/test/render.js';
import { parseFixtureModel, FIXTURE_WALL_A } from './anonymized-export/anonymized-export-fixture.test-support.js';
import { CommandPalette } from './CommandPalette.js';
import { EntityContextMenu } from './EntityContextMenu.js';
import { MobileToolbar } from './MobileToolbar.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import { ElementsTab } from './ribbon/tabs/ElementsTab.js';

const SHOW_ALL = 'Reveal all geometry';
const COPY_GLOBAL_ID = 'Copy IFC GlobalId';
const findNamedButton = (name: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === name);

function menuItem(name: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.getAttribute('aria-label') === name);
}

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({
    models: new Map(), activeModelId: null, selectedEntityId: null, selectedEntity: null,
    selectedEntityIds: new Set(), contextMenu: { isOpen: false, entityId: null, screenX: 0, screenY: 0 },
  });
});

describe('one action name across viewer surfaces (#5858)', () => {
  it('shows the same localized Show all name in ribbon, mobile, palette and canvas menu', () => {
    registerLocale('action-name-parity-5858', { [ACTION_NAME_KEYS.showAll]: SHOW_ALL });
    setLocale('action-name-parity-5858');

    render(<ElementsTab />);
    assert.ok(findNamedButton(SHOW_ALL), 'ribbon uses the canonical action name');
    cleanup();

    render(<MobileToolbar />);
    assert.ok(findNamedButton(SHOW_ALL), 'mobile toolbar uses the canonical action name');
    cleanup();

    render(
      <BimReactContext.Provider value={{} as BimContext}>
        <CommandPalette open onOpenChange={() => {}} />
      </BimReactContext.Provider>,
    );
    const search = document.querySelector('input') as HTMLInputElement;
    assert.ok(search);
    typeInto(search, SHOW_ALL);
    assert.ok([...document.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes(SHOW_ALL)),
      'palette uses the canonical action name');
    cleanup();

    act(() => useViewerStore.getState().openContextMenu(null, 10, 10));
    render(<EntityContextMenu />);
    assert.ok(menuItem(SHOW_ALL), 'canvas context menu uses the canonical action name');
  });

  it('shows Copy GlobalId with EXPRESS spelling in ribbon, Properties and entity menu', async () => {
    registerLocale('copy-global-id-parity-5858', { [ACTION_NAME_KEYS.copyGlobalId]: COPY_GLOBAL_ID });
    setLocale('copy-global-id-parity-5858');
    const store = await parseFixtureModel();
    const model = {
      id: 'm1', name: 'm1.ifc', ifcDataStore: store, geometryResult: null, visible: true,
      collapsed: false, schemaVersion: 'IFC4', loadedAt: 1, fileSize: 0,
      idOffset: 0, maxExpressId: Math.max(...store.entityIndex.byId.keys()),
    } as FederatedModel;
    useViewerStore.setState({
      models: new Map([['m1', model]]), activeModelId: 'm1',
      selectedEntity: { modelId: 'm1', expressId: FIXTURE_WALL_A },
      selectedEntityId: FIXTURE_WALL_A, selectedEntityIds: new Set(),
    });

    render(<ElementsTab />);
    assert.ok(findNamedButton(COPY_GLOBAL_ID), 'ribbon uses the canonical EXPRESS name');
    cleanup();

    render(<PropertiesPanel />);
    assert.ok(findNamedButton(COPY_GLOBAL_ID), 'Properties copy control uses the canonical EXPRESS name');
    cleanup();

    act(() => useViewerStore.getState().openContextMenu(FIXTURE_WALL_A, 10, 10));
    render(<EntityContextMenu />);
    assert.ok(menuItem(COPY_GLOBAL_ID), 'entity context menu uses the canonical EXPRESS name');
  });
});
