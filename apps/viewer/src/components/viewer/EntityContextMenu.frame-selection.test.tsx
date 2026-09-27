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
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { EntityContextMenu } from './EntityContextMenu.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { setPlatform } from '@/test/platform.js';
import { resolveEnglish } from '@/i18n/registry.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { press } from '@/test/render.js';
import { SURFACE_COMMANDS } from './surface-commands.js';
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
function render(host?: ExtensionHostService): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(host
    ? <ExtensionHostContext.Provider value={host}><EntityContextMenu /></ExtensionHostContext.Provider>
    : <EntityContextMenu />); });
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

  it('shows only the keyboard hints of actions with matching shortcuts (#5855)', () => {
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();
    const hints: Array<[string, string]> = [
      ['Frame selection', 'F'],
      // Every chord that hides, from the keyboard command table (#5836).
      ['Hide', 'Del, Backspace, Space'],
      ['Add to Collection', '=, +'],
      ['Remove from Collection', '−'],
      ['Save Collection View', 'B'],
    ];
    for (const [label, key] of hints) {
      const hint = menuItem(container, label).querySelectorAll('span')[1];
      assert.equal(hint?.textContent, key, `"${label}" shortcut hint`);
    }
    assert.equal(
      menuItem(container, 'Set Collection').querySelectorAll('span')[1],
      undefined,
      'Set Collection has no key binding, so its menu row does not claim one',
    );
  });

  it('shows the A hint on the canvas menu\'s "Show all"', () => {
    act(() => { useViewerStore.getState().openContextMenu(null, 10, 10); });
    const container = render();
    assert.equal(menuItem(container, 'Show all').querySelectorAll('span')[1]?.textContent, 'A');
  });
});

describe('EntityContextMenu — Duplicate key hint follows the platform (#5836)', () => {
  afterEach(() => {
    setPlatform(null);
    useViewerStore.setState({ mutationViews: new Map() });
  });

  function duplicateHint(platform: string): string | null | undefined {
    setPlatform(platform);
    // Duplicate needs an editable model: a mutation view makes `canEdit` true.
    useViewerStore.getState().registerMutationView('m1', new MutablePropertyView(null, 'm1'));
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();
    const row = [...container.querySelectorAll('button')].find((b) => b.querySelector('span')?.textContent === 'Duplicate');
    assert.ok(row, 'the Duplicate row rendered');
    return row.querySelectorAll('span')[1]?.textContent;
  }

  it('says Ctrl+D off Apple platforms', () => {
    assert.equal(duplicateHint('Win32'), 'Ctrl+D');
  });

  it('says ⌘D on Apple platforms', () => {
    assert.equal(duplicateHint('MacIntel'), '⌘D');
  });
});

it('exposes menu and menuitem roles when the entity menu opens (#5819)', () => {
  act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
  const container = render();
  const menu = container.querySelector('[role="menu"]');
  assert.ok(menu, 'the open context menu has a menu role');
  assert.equal(menuItem(container, 'Frame selection').getAttribute('role'), 'menuitem');
});

/** #5878: inspect every actual menu action, including rows without a registry marker. */
function assertContextActionsRegistered(
  container: HTMLElement,
  type = 'IfcWall',
  contributedIds: ReadonlySet<string> = new Set(),
): void {
  const menu = container.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(menu, 'the context menu is mounted');
  const actions = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
  assert.ok(actions.length > 0, 'the guard examines visible menu actions');
  const commands: Map<string, (typeof SURFACE_COMMANDS)[number]> = new Map(SURFACE_COMMANDS
    .filter((command) => command.surfaces.some((surface) => surface === 'context'))
    .map((command) => [command.id, command]));
  for (const action of actions) {
    const { commandId, extensionCommandId, commandDisclosure } = action.dataset;
    assert.equal([commandId, extensionCommandId, commandDisclosure].filter(Boolean).length, 1,
      `unregistered context action: ${action.outerHTML}`);
    if (commandId) {
      const command = commands.get(commandId);
      assert.ok(command, `${commandId} belongs to the context registry`);
      const params = command.contextLabelParams?.({ canEditInSession: true, contextEntityType: type });
      assert.equal(action.getAttribute('aria-label'), resolveEnglish(command.contextLabelKey ?? command.labelKey, params),
        `${commandId} uses its registered accessible name`);
    }
    if (extensionCommandId) {
      assert.ok(contributedIds.has(extensionCommandId),
        `${extensionCommandId} must come from a registered extension contribution`);
      assert.ok(!commands.has(extensionCommandId), 'an extension cannot masquerade as a core command');
      assert.match(extensionCommandId, /^[^:]+:.+$/, 'extension marker names its contributor and command');
    }
    if (commandDisclosure) {
      assert.equal(commandDisclosure, 'context:duplicate-direction');
      assert.equal(action.getAttribute('aria-haspopup'), 'menu', 'only the Duplicate submenu has a disclosure marker');
      assert.equal(action.textContent?.trim(), resolveEnglish('entityContextMenu.duplicateDirectionLabel'));
    }
  }
}

describe('context command ownership guard (#5878)', () => {
  afterEach(() => useViewerStore.setState({ editEnabled: false, mutationViews: new Map() }));

  it('covers entity actions and opens the registered Duplicate submenu by keyboard', () => {
    useViewerStore.setState({ editEnabled: true });
    useViewerStore.getState().registerMutationView('m1', new MutablePropertyView(null, 'm1'));
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();
    assertContextActionsRegistered(container);
    assert.ok(container.querySelector('[data-command-id="context:duplicate"]'));
    assert.equal(container.querySelectorAll('[data-command-disclosure="context:duplicate-direction"]').length, 1);
    const disclosure = container.querySelector<HTMLElement>('[data-command-disclosure="context:duplicate-direction"]');
    assert.ok(disclosure);
    act(() => disclosure.focus());
    press(disclosure, 'ArrowRight');
    act(() => mock.timers.tick(5));
    const firstDirection = container.querySelector<HTMLElement>('[data-command-id="context:duplicate-x-plus"]');
    assert.ok(firstDirection, 'keyboard navigation reveals the first registered duplicate direction');
    assert.equal(firstDirection.getAttribute('aria-label'), resolveEnglish('entityContextMenu.duplicateXPlus'));
    assertContextActionsRegistered(container);
  });

  it('covers the Edit-off entity menu and its disabled mutation controls', () => {
    useViewerStore.setState({ editEnabled: false, mutationViews: new Map() });
    act(() => { useViewerStore.getState().openContextMenu(globalId(FIXTURE_WALL_A), 10, 10); });
    const container = render();
    assertContextActionsRegistered(container);
    const duplicate = container.querySelector<HTMLButtonElement>('[data-command-id="context:duplicate"]');
    assert.ok(duplicate?.disabled, 'the registered Duplicate action explains its Edit-off denial');
  });

  it('covers the canvas action and permits only explicitly owned extension rows', () => {
    const host = new ExtensionHostService({
      sdk: createBimContext({ transport: {
        send: () => Promise.reject(new Error('transport unused')),
        subscribe: () => () => {}, close: () => {},
      } }),
    });
    host.slotRegistry.register('ext.guard', [{
      extensionId: 'ext.guard', slot: 'contextMenu.canvas',
      payload: { slot: 'contextMenu.canvas', command: 'inspect', title: 'Inspect scene' },
    }]);
    act(() => { useViewerStore.getState().openContextMenu(null, 10, 10); });
    const container = render(host);
    assertContextActionsRegistered(container, 'IfcWall', new Set(['ext.guard:inspect']));
    assert.equal(container.querySelector('[data-command-id="vis:show"]')?.getAttribute('aria-label'), 'Show all');
    assert.equal(container.querySelector('[data-extension-command-id="ext.guard:inspect"]')?.getAttribute('aria-label'), 'Inspect scene');
  });
});
