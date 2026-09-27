/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FederationRegistry } from '@ifc-lite/renderer';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { render, cleanup, click, advance, press } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { resolve } from '@/i18n/registry';
import { posthog } from '@/lib/analytics';
import { MobileToolbar } from './MobileToolbar';
import { SURFACE_COMMANDS } from './surface-commands';
import { EXPORT_SURFACE_COMMANDS } from './commandPaletteExports';

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState(initialState);
});

function command(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-command-id="${id}"]`);
  assert.ok(element, `mobile command ${id} is rendered`);
  return element;
}

async function openMore(): Promise<void> {
  const more = document.querySelector<HTMLElement>('[aria-label="More actions"]');
  assert.ok(more);
  press(more, 'ArrowDown');
  await advance(10);
}

it('mobile commands keep their table ids and act on the selected federated model (#5870)', async () => {
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
    events.push({ event, properties });
  });
  const registry = new FederationRegistry();
  const firstOffset = registry.registerModel('first', 11);
  const secondOffset = registry.registerModel('second', 11);
  const first = fixtureModel('first', { idOffset: firstOffset, entities: [{ expressId: 11, type: 'IfcWall' }] });
  const second = fixtureModel('second', { idOffset: secondOffset, entities: [{ expressId: 11, type: 'IfcWall' }] });
  const secondWall = registry.toGlobalId('second', 11);
  assert.equal(registry.getModelForGlobalId(secondWall), 'second');
  let fits = 0;
  useViewerStore.setState({
    ...fixtureModels(first, second),
    geometryResult: null,
    loading: false,
    activeTool: 'select',
    selectedEntityId: secondWall,
    selectedEntityIds: new Set([secondWall]),
    hiddenEntities: new Set(),
    cameraCallbacks: { fitAll: () => { fits += 1; } },
  });
  render(<BimReactContext.Provider value={{} as BimContext}><MobileToolbar /></BimReactContext.Provider>);

  for (const id of ['file:open', 'file:add-model', 'tool:select', 'tool:measure', 'tool:section', 'view:home', 'view:fit', 'vis:show']) {
    command(id);
  }
  click(command('tool:measure'));
  assert.equal(useViewerStore.getState().activeTool, 'measure');
  click(command('view:fit'));
  assert.equal(fits, 1, 'the table routes Fit to the live camera callback');

  await openMore();
  for (const id of ['ui:commands', 'tool:walk', 'vis:isolate', 'vis:hide', 'view:frame', 'view:projection', 'view:theme']) {
    command(id);
  }
  click(command('vis:hide'));
  assert.deepEqual([...useViewerStore.getState().hiddenEntities], [secondWall], 'Hide affects only the second model selection');
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);
  click(command('vis:show'));
  assert.equal(useViewerStore.getState().hiddenEntities.size, 0, 'Show all restores the hidden federated entity');
  const commandEvents = events.filter(({ event }) => event === 'command_executed')
    .map(({ properties }) => [properties.command_id, properties.surface]);
  assert.deepEqual(commandEvents, [
    ['tool:measure', 'mobile'], ['view:fit', 'mobile'], ['vis:hide', 'mobile'], ['vis:show', 'mobile'],
  ], 'each mounted mobile click emits exactly one command event');
});

it('a mounted mobile command still runs when telemetry capture fails (#5870)', () => {
  useViewerStore.setState({ activeTool: 'select', loading: false });
  mock.method(posthog, 'capture', () => { throw new Error('analytics unavailable'); });
  const warning = mock.method(console, 'warn', () => {});
  render(<BimReactContext.Provider value={{} as BimContext}><MobileToolbar /></BimReactContext.Provider>);

  click(command('tool:measure'));
  assert.equal(useViewerStore.getState().activeTool, 'measure');
  assert.equal(warning.mock.callCount(), 1, 'capture failure is reported once');
});

it('mobile Walk, projection, and theme commands preserve their toggles and live labels (#5870)', async () => {
  useViewerStore.setState({ activeTool: 'select', projectionMode: 'perspective', theme: 'light', loading: false });
  render(<BimReactContext.Provider value={{} as BimContext}><MobileToolbar /></BimReactContext.Provider>);

  await openMore();
  assert.match(command('view:projection').textContent ?? '', /Orthographic/);
  assert.match(command('view:theme').textContent ?? '', /Dark Mode/);
  click(command('tool:walk'));
  assert.equal(useViewerStore.getState().activeTool, 'walk');

  await openMore();
  click(command('tool:walk'));
  assert.equal(useViewerStore.getState().activeTool, 'select');

  await openMore();
  click(command('view:projection'));
  assert.equal(useViewerStore.getState().projectionMode, 'orthographic');
  await openMore();
  assert.match(command('view:projection').textContent ?? '', /Perspective/);
  click(command('view:theme'));
  assert.equal(useViewerStore.getState().theme, 'dark');
  await openMore();
  assert.match(command('view:theme').textContent ?? '', /Light Mode/);
});

it('renders the literal mobile command and export registry matrix with its labels (#5870)', async () => {
  useViewerStore.setState({
    ...fixtureModels(fixtureModel('m')),
    selectedEntityId: 1, selectedEntityIds: new Set([1]), loading: false,
    projectionMode: 'perspective', theme: 'light',
  });
  render(<BimReactContext.Provider value={{} as BimContext}><MobileToolbar /></BimReactContext.Provider>);
  await openMore();

  const commands = SURFACE_COMMANDS.filter((item) => item.surfaces.some((surface) => surface === 'mobile'));
  const rows = [...document.querySelectorAll<HTMLElement>('[data-command-id]')];
  assert.deepEqual(new Set(rows.map((row) => row.dataset.commandId)),
    new Set(commands.map((item) => item.id)), 'every declared mobile id has one rendered command');
  const state = { canEditInSession: true, projectionMode: 'perspective' as const, theme: 'light' as const };
  for (const item of commands) {
    const row = rows.find((candidate) => candidate.dataset.commandId === item.id);
    assert.ok(row);
    const rendered = row.getAttribute('aria-label') ?? row.textContent?.trim();
    const labelKey = 'mobileLabelKey' in item && item.mobileLabelKey
      ? item.mobileLabelKey(state) : item.labelKey;
    assert.equal(rendered, resolve(labelKey), `${item.id} uses its registered label`);
  }

  const exports = [...document.querySelectorAll<HTMLElement>('[data-export-row]')];
  assert.deepEqual(new Set(exports.map((row) => row.dataset.exportRow)),
    new Set(EXPORT_SURFACE_COMMANDS.map((item) => item.id)), 'every export registry row is rendered');
  for (const item of EXPORT_SURFACE_COMMANDS) {
    const row = exports.find((candidate) => candidate.dataset.exportRow === item.id);
    assert.ok(row);
    assert.equal(row.textContent?.trim(), resolve(item.labelKey), `${item.id} uses its registry label`);
    assert.equal(row.dataset.extensionExporterId, undefined, `${item.id} is owned by the core export registry`);
  }

  // #5878: inspect every actual action, including the one disclosure. A new
  // raw Button or DropdownMenuItem must fail even if it has no registry marker.
  const surface = document.querySelector<HTMLElement>('[data-command-surface="mobile"]');
  const menu = document.querySelector<HTMLElement>('[data-mobile-command-menu]');
  assert.ok(surface && menu);
  const controls = [
    ...surface.querySelectorAll<HTMLElement>('button'),
    ...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
  ];
  const commandIds: Set<string> = new Set(commands.map((item) => item.id));
  const exportIds: Set<string> = new Set(EXPORT_SURFACE_COMMANDS.map((item) => item.id));
  assert.equal(controls.length, commandIds.size + exportIds.size + 1, 'all mobile action controls are classified');
  for (const control of controls) {
    const { commandId, exportRow, extensionExporterId, commandDisclosure } = control.dataset;
    assert.equal([commandId, exportRow, commandDisclosure].filter(Boolean).length, 1,
      `unregistered mobile action: ${control.outerHTML}`);
    if (commandId) assert.ok(commandIds.has(commandId), `${commandId} is a registered mobile command`);
    if (exportRow) {
      assert.equal(extensionExporterId, undefined, 'no exporter extension is registered in this mounted fixture');
      assert.ok(exportIds.has(exportRow), `${exportRow} is a registered core export`);
    }
    if (commandDisclosure) {
      assert.equal(commandDisclosure, 'mobile:more', 'only More actions is a mobile disclosure');
      assert.equal(control.getAttribute('aria-label'), resolve('shellChrome.mobileToolbar.moreActionsAriaLabel'));
    }
  }
});

it('marks only a registered extension exporter as a mobile export exception (#5878)', async () => {
  const host = new ExtensionHostService({
    sdk: createBimContext({ transport: {
      send: () => Promise.reject(new Error('transport unused')),
      subscribe: () => () => {}, close: () => {},
    } }),
  });
  host.slotRegistry.register('ext.guard', [{
    extensionId: 'ext.guard', slot: 'exportMenu',
    payload: { id: 'report', name: 'Extension report', mimeType: 'text/plain', extension: 'txt', handler: 'export.js' },
  }]);
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), loading: false });
  render(
    <BimReactContext.Provider value={{} as BimContext}>
      <ExtensionHostContext.Provider value={host}><MobileToolbar /></ExtensionHostContext.Provider>
    </BimReactContext.Provider>,
  );
  await openMore();
  const row = document.querySelector<HTMLElement>('[data-export-row="export:ext:ext.guard:report"]');
  assert.ok(row, 'the installed exporter is mounted as a real menu item');
  assert.equal(row.dataset.extensionExporterId, row.dataset.exportRow);
  assert.equal(row.textContent?.trim(), 'Extension report');
  assert.ok(!EXPORT_SURFACE_COMMANDS.some((core) => core.id === row.dataset.exportRow),
    'an extension exception cannot own a core export ID');
  assert.equal(document.querySelectorAll('[data-command-disclosure="mobile:more"]').length, 1);
});
