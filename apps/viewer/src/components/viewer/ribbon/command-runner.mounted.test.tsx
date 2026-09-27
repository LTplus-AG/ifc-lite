/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { advance, cleanup, click, render } from '@/test/render.js';
import { CommandPalette } from '../CommandPalette.js';
import type { FileCommands } from '../toolbar/useFileCommands.js';
import { AnalyzeTab } from './tabs/AnalyzeTab.js';
import { FileTab } from './tabs/FileTab.js';
import { HomeTab } from './tabs/HomeTab.js';
import { ViewTab } from './tabs/ViewTab.js';

const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState(initialState);
});

it('runs mounted ribbon and palette Reposition through the same command once each (#5870)', async () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), repositionOpen: false });
  const events: Array<{ command_id: string; surface: string }> = [];
  mock.method(posthog, 'capture', (event: string, properties: { command_id?: string; surface?: string }) => {
    if (event === 'command_executed') events.push(properties as { command_id: string; surface: string });
  });

  render(<HomeTab />);
  const ribbon = document.querySelector<HTMLButtonElement>('[data-command-id="model:reposition"]');
  assert.ok(ribbon);
  click(ribbon);
  assert.equal(useViewerStore.getState().repositionOpen, true, 'ribbon starts real model placement');
  useViewerStore.getState().closeReposition();
  cleanup();

  render(<BimReactContext.Provider value={{} as BimContext}>
    <CommandPalette open onOpenChange={() => {}} />
  </BimReactContext.Provider>);
  const palette = document.querySelector<HTMLButtonElement>('[role="option"][data-command-id="model:reposition"]');
  assert.ok(palette);
  click(palette);
  await advance(32);
  assert.equal(useViewerStore.getState().repositionOpen, true, 'palette starts the same model placement');
  assert.deepEqual(events, [
    { command_id: 'model:reposition', surface: 'ribbon' },
    { command_id: 'model:reposition', surface: 'palette' },
  ]);
});

it('keeps View world cleanup and camera callbacks in registered ribbon actions (#5870)', () => {
  let zooms = 0;
  useViewerStore.setState({
    cesiumAvailable: true, cesiumEnabled: true,
    cesiumPlacementEditMode: true, activeTool: 'cesium-placement',
    cameraCallbacks: { ...useViewerStore.getState().cameraCallbacks, zoomIn: () => { zooms++; } },
  });
  const events: Array<{ command_id: string; surface: string }> = [];
  mock.method(posthog, 'capture', (event: string, properties: { command_id?: string; surface?: string }) => {
    if (event === 'command_executed') events.push(properties as { command_id: string; surface: string });
  });
  render(<ViewTab />);
  const world = document.querySelector<HTMLButtonElement>('[data-command-id="view:world"]');
  assert.ok(world);
  click(world);
  const state = useViewerStore.getState();
  assert.equal(state.cesiumEnabled, false);
  assert.equal(state.cesiumPlacementEditMode, false);
  assert.equal(state.activeTool, 'select');
  const zoom = document.querySelector<HTMLButtonElement>('[data-command-id="view:zoom-in"]');
  assert.ok(zoom);
  click(zoom);
  assert.equal(zooms, 1, 'the shared camera callback runs once');
  assert.deepEqual(events, [
    { command_id: 'view:world', surface: 'ribbon' },
    { command_id: 'view:zoom-in', surface: 'ribbon' },
  ]);
});

it('passes File host inputs through the registered ribbon action once (#5870)', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  const actions: string[] = [];
  const fileCommands: FileCommands = {
    fileInputs: null, openShareDialog: () => { actions.push('share'); },
    handleOpenClick: async () => { actions.push('open'); },
    handleAddModelClick: async () => { actions.push('add'); },
    handleRefresh: async () => { actions.push('refresh'); },
    canRefresh: true, hasModelsLoaded: true,
  };
  const events: Array<{ command_id: string; surface: string }> = [];
  mock.method(posthog, 'capture', (event: string, properties: { command_id?: string; surface?: string }) => {
    if (event === 'command_executed') events.push(properties as { command_id: string; surface: string });
  });
  render(<FileTab fileCommands={fileCommands} />);
  for (const id of ['file:open', 'file:add-model', 'file:refresh']) {
    const button = document.querySelector<HTMLButtonElement>(`[data-command-id="${id}"]`);
    assert.ok(button);
    click(button);
  }
  assert.deepEqual(actions, ['open', 'add', 'refresh']);
  assert.deepEqual(events, ['file:open', 'file:add-model', 'file:refresh']
    .map((command_id) => ({ command_id, surface: 'ribbon' })));
});

it('keeps Analyze panel toggling while reporting the registered ribbon command (#5870)', () => {
  useViewerStore.setState({ bcfPanelVisible: false });
  const events: Array<{ command_id: string; surface: string }> = [];
  mock.method(posthog, 'capture', (event: string, properties: { command_id?: string; surface?: string }) => {
    if (event === 'command_executed') events.push(properties as { command_id: string; surface: string });
  });
  render(<AnalyzeTab />);
  const bcf = document.querySelector<HTMLButtonElement>('[data-command-id="panel:bcf"]');
  assert.ok(bcf);
  click(bcf);
  assert.equal(useViewerStore.getState().bcfPanelVisible, true);
  assert.deepEqual(events, [{ command_id: 'panel:bcf', surface: 'ribbon' }]);
});
