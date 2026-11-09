/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ElementsTab } from './ribbon/tabs/ElementsTab';
import { BimReactContext } from '@/sdk/BimProvider';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, MESH_WALL, seedModelingSession } from '@/test/modeling-session-fixture';
import { advance, cleanup, click, press, render, type as typeInto, waitFor } from '@/test/render';
import { CommandPalette } from './CommandPalette';
import { EntityContextMenu } from './EntityContextMenu';
import { selectedEntityActionTarget } from './selected-entity-actions';
import { RECENT_KEY } from './commandPaletteSearch';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { paletteSurfaceCommands } from './surface-commands';
import { clearCopyClipboard } from '@/lib/commands/modeling/copy-clipboard';
import { setLocale } from '@/i18n';
import '@/lib/commands/modeling/builtin';

const original = useViewerStore.getState();
beforeEach(async () => {
  setLocale('en');
  localStorage.clear();
  await seedModelingSession();
  clearCopyClipboard();
  useViewerStore.setState({ collabRole: null, canCollabEdit: () => true, selectedEntityId: null,
    selectedEntityIds: new Set(), selectedEntity: null, contextMenu: { isOpen: false, entityId: null, screenX: 0, screenY: 0 } });
});
afterEach(() => { cleanup(); useViewerStore.setState(original); localStorage.clear(); });

function Harness({ ribbon = false }: { ribbon?: boolean }) {
  const [open, setOpen] = useState(false);
  return <TooltipProvider><BimReactContext.Provider value={{} as BimContext}>
    <button onClick={() => setOpen(true)}>Commands</button>
    <CommandPalette open={open} onOpenChange={setOpen} />
    {ribbon && <ElementsTab />}
    <EntityContextMenu />
  </BimReactContext.Provider></TooltipProvider>;
}
function mount() {
  const ui = render(<Harness />);
  const launcher = ui.querySelector<HTMLButtonElement>('button')!;
  launcher.focus(); click(launcher);
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]');
  assert.ok(input);
  return { launcher, input };
}
function option(id: string) {
  const row = document.querySelector<HTMLElement>(`[role="option"][data-command-id="${id}"]`);
  assert.ok(row, `missing ${id}`);
  return row;
}
function select(id: number) {
  const s = useViewerStore.getState();
  s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, id));
}

test('#8947 renderer target precedence rejects property-only and unresolved selections', () => {
  const s = useViewerStore.getState();
  const id = toGlobalIdFromModels(s.models, MODEL_ID, MESH_WALL);
  useViewerStore.setState({ selectedEntity: { modelId: MODEL_ID, expressId: MESH_WALL } });
  assert.equal(selectedEntityActionTarget(), null);
  useViewerStore.setState({ selectedEntityId: id });
  assert.equal(selectedEntityActionTarget(), id);
  useViewerStore.setState({ selectedEntityIds: new Set([id]), selectedEntityId: 987654321 });
  assert.equal(selectedEntityActionTarget(), id, 'set beats unrelated scalar');
  useViewerStore.setState({ selectedEntityIds: new Set(), selectedEntityId: 987654321 });
  assert.equal(selectedEntityActionTarget(), null);
});

for (const federated of [false, true]) test(`#8947 selected entity destination opens canonical children (${federated ? 'federated' : 'single'})`, async () => {
  if (federated) {
    const s = useViewerStore.getState();
    const m = s.models.get(MODEL_ID)!;
    useViewerStore.setState({ models: new Map([[MODEL_ID, { ...m, idOffset: 1_000_000 }], ['other', { ...m, id: 'other', idOffset: 2_000_000 }]]) });
  }
  select(MESH_WALL);
  const expected = useViewerStore.getState().selectedEntityId;
  const { input, launcher } = mount();
  typeInto(input, 'Copy GlobalId');
  const destination = option('elements:entity-actions');
  assert.match(destination.textContent ?? '', /Selected entity actions/);
  assert.equal(destination.getAttribute('aria-selected'), 'true');
  assert.notEqual(destination.getAttribute('aria-disabled'), 'true');
  const transitions: { open: boolean; entityId: number | null }[] = [];
  const unsubscribe = useViewerStore.subscribe((state, previous) => {
    if (state.contextMenu !== previous.contextMenu && transitions.length < 12) {
      transitions.push({ open: state.contextMenu.isOpen, entityId: state.contextMenu.entityId });
    }
  });
  press(input, 'Enter');
  // Activation hands focus off at palette close; Radix then mounts and focuses its menu.
  try {
    await waitFor(() => document.querySelector('[role="menu"]') !== null, 'real entity menu mounts after palette close');
  } catch (cause) {
    const state = useViewerStore.getState();
    throw new Error(`Entity menu did not mount: ${JSON.stringify({ transitions,
      currentTarget: selectedEntityActionTarget(), contextMenu: state.contextMenu,
      recent: localStorage.getItem(RECENT_KEY), focusedRole: document.activeElement?.getAttribute('role'),
      paletteOpen: Boolean(document.querySelector('input[role="combobox"]')) })}`, { cause });
  } finally { unsubscribe(); }
  await waitFor(() => document.querySelector('[role="menu"]')?.contains(document.activeElement) === true,
    'focus enters the real entity menu');
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(menu, 'real mounted menu opens after palette closes');
  assert.equal(useViewerStore.getState().contextMenu.entityId, expected);
  assert.ok(menu.contains(document.activeElement), 'focus enters the entity menu');
  for (const child of ['context:copy-global-id', 'context:select-all-type', 'context:select-same-storey', 'context:export-anonymized']) {
    assert.ok(menu.querySelector(`[data-command-id="${child}"]`), child);
  }
  const sameType = menu.querySelector<HTMLElement>('[data-command-id="context:select-all-type"]')!;
  click(sameType);
  assert.ok(useViewerStore.getState().selectedEntityIds.has(expected!));
  await waitFor(() => document.activeElement === launcher, 'menu restores the real palette launcher');
  assert.equal(document.activeElement === launcher, true, 'menu restores the real palette launcher');
});

test('#8947 overlay-created target opens the same menu and Escape recovers focus', async () => {
  const s = useViewerStore.getState();
  const column = s.addColumn(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
  assert.ok('expressId' in column);
  select(column.expressId);
  assert.equal(selectedEntityActionTarget(), useViewerStore.getState().selectedEntityId);
  const { input, launcher } = mount();
  typeInto(input, 'Selected entity actions');
  press(input, 'Enter');
  await waitFor(() => document.querySelector('[role="menu"]')?.contains(document.activeElement) === true,
    'overlay entity menu mounts and receives focus');
  assert.ok(document.querySelector('[role="menu"]'));
  press(document.activeElement!, 'Escape');
  await waitFor(() => !useViewerStore.getState().contextMenu.isOpen && document.activeElement === launcher,
    'Escape closes overlay menu and returns focus');
  assert.equal(useViewerStore.getState().contextMenu.isOpen, false);
  assert.equal(document.activeElement === launcher, true);
});

test('#8947 entity destination rechecks a lost selection before deferred activation', async () => {
  select(MESH_WALL);
  const { input } = mount();
  typeInto(input, 'Selected entity actions');
  click(option('elements:entity-actions'));
  act(() => useViewerStore.setState({ selectedEntityId: null, selectedEntityIds: new Set() }));
  await advance(60);
  assert.equal(useViewerStore.getState().contextMenu.isOpen, false);
  assert.equal(localStorage.getItem(RECENT_KEY), null);
});

test('#8947 hierarchy and search destinations reveal their existing controls', () => {
  const modes = { spatial: 'spatial', class: 'type', type: 'ifc-type', materials: 'material', groups: 'groups', 'presentation-layers': 'presentation-layers' };
  for (const [id, mode] of Object.entries(modes)) {
    useViewerStore.setState({ leftPanelCollapsed: true });
    paletteSurfaceCommands({ canEditInSession: true }, () => {}).find(row => row.id === `elements:${id}`)!.action();
    assert.equal(useViewerStore.getState().hierarchyMode, mode);
    assert.equal(useViewerStore.getState().leftPanelCollapsed, false);
  }
  paletteSurfaceCommands({ canEditInSession: true }, () => {}).find(row => row.id === 'elements:search')!.action();
  assert.equal(useViewerStore.getState().searchModalOpen, true);
  assert.equal(useViewerStore.getState().searchModalTab, 'search');
});

test('#8947 mounted palette launches element move and refuses a deferred role downgrade', async () => {
  const s = useViewerStore.getState();
  const result = s.addColumn(MODEL_ID, STOREY, { Position: [1, 2, 0], Width: 0.3, Depth: 0.3, Height: 3 });
  assert.ok('expressId' in result);
  select(result.expressId);
  const { input } = mount();
  typeInto(input, 'Move selected elements');
  click(option('tool:move'));
  await advance(60);
  assert.equal(getCommandRuntime().command?.id, 'element.move');
  act(() => useViewerStore.getState().exitModelWorkspace());
  cleanup();
  const second = mount();
  typeInto(second.input, 'Rotate selected elements');
  click(option('tool:rotate'));
  act(() => useViewerStore.setState({ collabRole: 'viewer', canCollabEdit: () => false }));
  await advance(60);
  assert.equal(useViewerStore.getState().session, null);
  assert.equal(getCommandRuntime().command, null);
  assert.ok(!JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]').includes('tool:rotate'));
});

test('#8947 unavailable entity reason updates live from property-only to renderer selection', () => {
  useViewerStore.setState({ selectedEntity: { modelId: MODEL_ID, expressId: MESH_WALL } });
  const { input } = mount();
  typeInto(input, 'Selected entity actions');
  assert.equal(option('elements:entity-actions').getAttribute('aria-disabled'), 'true');
  assert.match(option('elements:entity-actions').textContent ?? '', /property-only/);
  act(() => select(MESH_WALL));
  assert.notEqual(option('elements:entity-actions').getAttribute('aria-disabled'), 'true');
});

// #8947 / review4510011624: renderer refs use "legacy", while the live edit view
// uses "__legacy__". Exercise real palette/ribbon entry and effective menu actions.
for (const surface of ['palette', 'ribbon'] as const) {
  for (const target of ['existing', 'deleted', 'created'] as const) {
    test(`#8947 ${surface} legacy ${target} target uses the live mutation view`, async () => {
      const store = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!;
      const view = new MutablePropertyView(store.properties || null, '__legacy__');
      view.setExpressIdWatermark(Math.max(...store.entities.expressId));
      const created = view.createEntity('IfcWall', [
        '0000000000000000000999', null, 'Legacy new wall', null, null, null, null, null,
      ]);
      if (target !== 'existing') view.deleteEntity(MESH_WALL);
      const targetId = target === 'created' ? created.expressId : MESH_WALL;
      useViewerStore.setState({ models: new Map(), ifcDataStore: store,
        mutationViews: new Map([['__legacy__', view]]),
        selectedEntityId: targetId, selectedEntityIds: new Set(), selectedEntity: null });
      const ui = render(<Harness ribbon={surface === 'ribbon'} />);
      const launcher = ui.querySelector<HTMLButtonElement>(surface === 'palette'
        ? 'button' : 'button[data-command-id="elements:entity-actions"]');
      assert.ok(launcher);
      if (surface === 'ribbon') assert.equal(launcher.disabled, target === 'deleted');
      launcher.focus(); click(launcher);
      if (surface === 'palette') {
        const input = document.querySelector<HTMLInputElement>('input[role="combobox"]');
        assert.ok(input); typeInto(input, 'Selected entity actions');
        const row = option('elements:entity-actions');
        assert.equal(row.getAttribute('aria-disabled') === 'true', target === 'deleted');
        press(input, 'Enter');
      }
      if (target === 'deleted') {
        await advance(80);
        assert.equal(document.querySelector('[role="menu"]'), null, 'deleted target cannot open a menu');
        assert.equal(useViewerStore.getState().contextMenu.isOpen, false);
        assert.equal(localStorage.getItem(RECENT_KEY), null, 'refusal records no palette use');
        return;
      }
      await waitFor(() => document.querySelector('[role="menu"]')?.contains(document.activeElement) === true,
        'live legacy menu mounts and receives focus');
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      assert.ok(menu);
      assert.equal(useViewerStore.getState().contextMenu.entityId, targetId);
      const selectType = menu.querySelector<HTMLElement>('[data-command-id="context:select-all-type"]');
      assert.ok(selectType);
      assert.match(selectType.textContent ?? '', /IfcWall/);
      click(selectType);
      assert.deepEqual(useViewerStore.getState().selectedEntityIds,
        new Set(target === 'existing' ? [MESH_WALL, created.expressId] : [created.expressId]),
        'actual menu action includes overlay walls and excludes deleted source walls');
      await waitFor(() => document.activeElement === launcher, 'legacy menu restores its actual launcher');
    });
  }
}

// #8947 / review4510162121: eligibility must react while the ribbon stays mounted.
for (const legacy of [false, true]) test(`#8947 ribbon tracks unresolved, deleted and created targets (${legacy ? 'legacy' : 'model'})`, async () => {
  const store = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!;
  const key = legacy ? '__legacy__' : MODEL_ID;
  const view = new MutablePropertyView(store.properties || null, key);
  view.setExpressIdWatermark(Math.max(...store.entities.expressId));
  useViewerStore.setState({ ...(legacy ? { models: new Map(), ifcDataStore: store } : {}),
    mutationViews: new Map([[key, view]]), selectedEntityId: 987654321, selectedEntityIds: new Set() });
  const ui = render(<Harness ribbon />);
  const button = ui.querySelector<HTMLButtonElement>('button[data-command-id="elements:entity-actions"]');
  assert.ok(button);
  assert.equal(button.disabled, true, 'unresolvable renderer selection is disabled');
  click(button);
  assert.equal(useViewerStore.getState().contextMenu.isOpen, false);
  async function selectType(target: number, expected: number[]) {
    act(() => useViewerStore.setState({ selectedEntityId: target, selectedEntityIds: new Set() }));
    assert.equal(button!.disabled, false);
    button!.focus(); click(button!);
    await waitFor(() => document.querySelector('[role="menu"]')?.contains(document.activeElement) === true,
      'canonical menu receives focus');
    const action = document.querySelector<HTMLElement>('[role="menu"] [data-command-id="context:select-all-type"]');
    assert.ok(action); click(action);
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set(expected));
    await waitFor(() => document.activeElement === button, 'actual ribbon launcher regains focus');
  }
  await selectType(MESH_WALL, [MESH_WALL]);
  act(() => { view.deleteEntity(MESH_WALL); useViewerStore.getState().bumpMutationVersion(); });
  assert.equal(button.disabled, true, 'deletion invalidates the mounted control without changing selection');
  click(button);
  assert.equal(useViewerStore.getState().contextMenu.isOpen, false);
  const created = view.createEntity('IfcWall', ['0000000000000000000998', null, 'Created wall', null, null, null, null, null]);
  await selectType(created.expressId, [created.expressId]);
});
