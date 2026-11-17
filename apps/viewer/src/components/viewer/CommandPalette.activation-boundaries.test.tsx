/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import '@/lib/commands/modeling/builtin';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { setLocale } from '@/i18n';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { cleanup, click, press, render, type as typeInto } from '@/test/render';
import { clearDownloads, downloadedNames } from '@/test/download-capture';
import { MODEL_ID, ROTATED_BEAM, seedModelingSession } from '@/test/modeling-session-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { modelWorkspaceTarget } from '@/lib/commands/modeling/workspace-target';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { CommandPalette } from './CommandPalette';
import { RECENT_KEY } from './commandPaletteSearch';

const original = useViewerStore.getState();
const executions: string[] = [];
beforeEach(() => {
  setLocale('en');
  localStorage.clear();
  clearDownloads();
  executions.length = 0;
  useViewerStore.setState({ collabRole: null, loading: false });
  mock.method(posthog, 'capture', (event: string) => {
    if (event === 'command_executed') executions.push(event);
  });
});
afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState(original);
  localStorage.clear();
  clearDownloads();
});

function mount(query: string, onOpenChange: (open: boolean) => void = () => {}) {
  render(<BimReactContext.Provider value={{} as BimContext}>
    <CommandPalette open onOpenChange={onOpenChange} />
  </BimReactContext.Provider>);
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  typeInto(input, query);
  return input;
}

function row(id: string) {
  const option = document.querySelector<HTMLButtonElement>(`[role="option"][data-command-id="${id}"]`);
  assert.ok(option, `${id} remains discoverable`);
  return option;
}

test('existing but refused prospective workplane cannot close or enter Model workspace (#8947)', async () => {
  await seedModelingSession();
  const model = useViewerStore.getState().models.get(MODEL_ID)!;
  const target = modelWorkspaceTarget(useViewerStore.getState());
  assert.ok(target && target.storeyId !== null, 'parsed IFC has a storey');
  useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, federationAlignmentStatus: 'reprojected' }]]) });
  let closes = 0;
  const input = mount('Draw walls', () => { closes++; });
  assert.equal(row('tool:wall').getAttribute('aria-disabled'), 'true');
  assert.match(row('tool:wall').textContent ?? '', /Choose a valid modeling workplane/);
  click(row('tool:wall'));
  press(input, 'Enter');
  assert.equal(closes, 0);
  assert.equal(useViewerStore.getState().workspaceMode, 'view');
  assert.equal(useViewerStore.getState().session, null);
  assert.equal(localStorage.getItem(RECENT_KEY), null);
  assert.deepEqual(executions, []);
});

test('Push/Pull refuses property-only selection before entering an empty command (#8947)', async () => {
  await seedModelingSession();
  useViewerStore.setState({ selectedEntity: { modelId: MODEL_ID, expressId: ROTATED_BEAM },
    selectedEntityId: null, selectedEntityIds: new Set() });
  let closes = 0;
  const input = mount('Push/Pull', () => { closes++; });
  assert.equal(row('tool:push-pull').getAttribute('aria-disabled'), 'true');
  click(row('tool:push-pull'));
  press(input, 'Enter');
  assert.equal(closes, 0);
  assert.equal(useViewerStore.getState().session, null);
  assert.equal(useViewerStore.getState().workspaceMode, 'view');
  assert.equal(localStorage.getItem(RECENT_KEY), null);
  assert.deepEqual(executions, []);
  act(() => useViewerStore.setState({ selectedEntityId: ROTATED_BEAM }));
  assert.equal(row('tool:push-pull').getAttribute('aria-disabled'), null, 'the actual command target enables the row');
});

test('held export frame cannot combine one parsed model with another model identity (#8947)', async () => {
  await seedModelingSession();
  const a = useViewerStore.getState().models.get(MODEL_ID)!;
  assert.ok(a.ifcDataStore);
  const b = { ...fixtureModel('b.ifc'), ifcDataStore: await parseFixtureModel() };
  assert.notEqual(a.ifcDataStore, b.ifcDataStore);
  assert.notEqual(a.ifcDataStore?.entities.count, b.ifcDataStore.entities.count, 'distinguishable parsed fixtures');
  useViewerStore.setState({ models: new Map([[MODEL_ID, a], [b.id, b]]), ifcDataStore: a.ifcDataStore });
  mount('Export JSON');
  assert.equal(row('export:json').getAttribute('aria-disabled'), null);
  const originalFrame = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  const flush = () => act(() => { for (const frame of frames.splice(0)) frame(0); });
  try {
    click(row('export:json'));
    act(() => useViewerStore.getState().setActiveModel(b.id));
    assert.equal(useViewerStore.getState().ifcDataStore, b.ifcDataStore);
    flush();
    assert.deepEqual(downloadedNames(), [], 'stale export refuses at the real download boundary');
    assert.equal(localStorage.getItem(RECENT_KEY), null);
    assert.deepEqual(executions, []);
    click(row('export:json'));
    flush();
    assert.equal(downloadedNames().length, 1, 'a fresh action on the new model still exports');
    assert.equal(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')[0], 'export:json');
    assert.equal(executions.length, 1);
  } finally {
    globalThis.requestAnimationFrame = originalFrame;
  }
});
