/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { resolve } from '@/i18n/registry';
import { cleanup, click, render, type as typeInto } from '@/test/render.js';
import type { FileCommands } from './toolbar/useFileCommands.js';
import { FileTab } from './ribbon/tabs/FileTab.js';
import { ElementsTab } from './ribbon/tabs/ElementsTab.js';
import { CommandPalette } from './CommandPalette.js';

// Dynamic import keeps the mounted regression runnable when the changed-test
// oracle reverts the newly added registry. Its ribbon assertion must then fail
// on the missing controls, rather than failing to load this test file.
const loadRegistry = async () => import('./surface-commands.js').catch(() => null);

const EXPECTED_IDS = [
  'file:save-federation-setup', 'file:open-federation-setup', 'file:model-tags',
  'vis:toggle-iso', 'vis:reset-colors',
] as const;
const VISIBILITY_IDS = [
  'vis:hide', 'vis:show', 'vis:set-iso', 'vis:add-iso', 'vis:remove-iso',
  'vis:toggle-iso', 'vis:save-view', 'vis:toggle-presentation', 'vis:clear-iso',
  'vis:spaces', 'vis:spatialZones', 'vis:openings', 'vis:site',
  'vis:ifcAnnotations', 'vis:ifcGrid', 'vis:reset-colors',
] as const;

const FILE_COMMANDS: FileCommands = {
  fileInputs: null, openShareDialog: () => {},
  handleOpenClick: async () => {}, handleAddModelClick: async () => {},
  handleRefresh: async () => {}, canRefresh: false, hasModelsLoaded: false,
};

afterEach(() => cleanup());

describe('shared palette and ribbon commands (#5870)', () => {
  it('renders every declared ribbon home with its one registry name and icon', async () => {
    render(<FileTab fileCommands={FILE_COMMANDS} />);
    render(<ElementsTab />);

    const rendered = [...document.querySelectorAll<HTMLButtonElement>('[data-command-id]')];
    assert.deepEqual(new Set(rendered.map((button) => button.dataset.commandId)), new Set(EXPECTED_IDS),
      'every newly reachable command has one ribbon home');
    const registry = await loadRegistry();
    assert.ok(registry, 'the shared registry loads');
    const { SURFACE_COMMANDS, paletteSurfaceCommands } = registry;
    const registered = new Set(SURFACE_COMMANDS.filter((command) => command.surfaces.some((surface) => surface === 'ribbon')).map((command) => command.id));
    assert.equal(new Set(SURFACE_COMMANDS.map((command) => command.id)).size, SURFACE_COMMANDS.length,
      'command ids are unique');
    assert.deepEqual(new Set(rendered.map((button) => button.dataset.commandId)), registered,
      'every registry-declared ribbon command is rendered');
    for (const button of rendered) {
      const definition = SURFACE_COMMANDS.find((command) => command.id === button.dataset.commandId);
      assert.ok(definition, 'ribbon command id exists in the shared table');
      assert.equal(button.getAttribute('aria-label'), resolve(definition.labelKey));
      assert.ok(button.querySelector('svg'), `${definition.id} has the registry icon`);
    }

    const palette = paletteSurfaceCommands({ canEditInSession: true, cesiumAvailable: false }, () => {});
    assert.deepEqual(new Set(palette.map((command) => command.id)),
      new Set(SURFACE_COMMANDS.filter((command) => command.surfaces.some((surface) => surface === 'palette')
        && command.enabled({ canEditInSession: true, cesiumAvailable: false })).map((command) => command.id)),
      'every palette-declared command is available there');
    assert.deepEqual(palette.filter((command) => command.id.startsWith('vis:')).map((command) => command.id),
      [...VISIBILITY_IDS], 'the migrated visibility family keeps its browse order');
    for (const row of palette) {
      const definition = SURFACE_COMMANDS.find((command) => command.id === row.id);
      assert.ok(definition);
      assert.equal(row.labelKey, definition.labelKey);
      assert.equal(row.icon, definition.icon);
    }
    assert.equal(palette.find((command) => command.id === 'file:open-federation-setup')?.immediate, true,
      'opening the file picker retains browser user activation');
    const openFile = palette.find((command) => command.id === 'file:open');
    assert.ok(openFile);
    assert.equal(openFile.immediate, true, 'Open File must keep browser user activation');
    let openEvents = 0;
    const onOpen = () => { openEvents += 1; };
    window.addEventListener('ifc-lite:open-files', onOpen);
    try { openFile.action(); } finally { window.removeEventListener('ifc-lite:open-files', onOpen); }
    assert.equal(openEvents, 1, 'the shared palette row reaches the real file picker event');
  });

  it('runs the same federation setup and tag actions from ribbon and palette', async () => {
    render(<FileTab fileCommands={FILE_COMMANDS} />);
    const registry = await loadRegistry();
    assert.ok(registry);
    const cases = [
      ['file:save-federation-setup', 'ifc-lite:save-federation-setup'],
      ['file:open-federation-setup', 'ifc-lite:open-federation-setup'],
      ['file:model-tags', 'ifc-lite:edit-model-tags'],
    ] as const;
    const palette = registry.paletteSurfaceCommands({ canEditInSession: true, cesiumAvailable: false }, () => {});
    for (const [id, eventName] of cases) {
      let events = 0;
      const listener = () => { events += 1; };
      window.addEventListener(eventName, listener);
      try {
        const button = document.querySelector<HTMLButtonElement>(`[data-command-id="${id}"]`);
        assert.ok(button, `${id} ribbon home`);
        click(button);
        const row = palette.find((command) => command.id === id);
        assert.ok(row, `${id} palette row`);
        row.action();
        assert.equal(events, 2, `${id} reaches the same action from both surfaces`);
      } finally {
        window.removeEventListener(eventName, listener);
      }
    }
  });

  it('resets real viewer colors from the ribbon and retains the palette script action', async () => {
    let resets = 0;
    const bim = { viewer: { resetColors: () => { resets += 1; } } } as BimContext;
    render(<BimReactContext.Provider value={bim}><ElementsTab /></BimReactContext.Provider>);
    const button = document.querySelector<HTMLButtonElement>('[data-command-id="vis:reset-colors"]');
    assert.ok(button);
    click(button);
    assert.equal(resets, 1, 'ribbon calls the SDK viewer reset');

    const registry = await loadRegistry();
    assert.ok(registry);
    const scripts: string[] = [];
    const row = registry.paletteSurfaceCommands({ canEditInSession: true, cesiumAvailable: false }, (code) => { scripts.push(code); })
      .find((command) => command.id === 'vis:reset-colors');
    assert.ok(row);
    row.action();
    assert.ok(scripts[0]?.includes('bim.viewer.resetColors()'), 'palette keeps its sandbox behavior');
  });

  it('keeps the old Basket search phrase hidden while showing the canonical Collection name', () => {
    render(
      <BimReactContext.Provider value={{} as BimContext}>
        <CommandPalette open onOpenChange={() => {}} />
      </BimReactContext.Provider>,
    );
    const search = document.querySelector<HTMLInputElement>('input');
    assert.ok(search);
    typeInto(search, 'Toggle Basket Visibility');
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.ok(options.some((option) => option.textContent?.includes('Toggle Collection Visibility')),
      'legacy search reaches the renamed command');
    assert.ok(options.every((option) => !option.textContent?.includes('Toggle Basket Visibility')),
      'the old phrase is not displayed as a second command name');
  });
});
