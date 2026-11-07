/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { act, useState, type Dispatch, type SetStateAction } from 'react';
import { Puzzle } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import type { CommandContribution, ExporterContribution, RuntimeRunResult, SlotContribution } from '@ifc-lite/extensions';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import type { ExporterOutput } from '@/services/extensions/host-exporters';
import { setLocale } from '@/i18n';
import { posthog } from '@/lib/analytics';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { useViewerStore } from '@/store';
import { cleanup, click, press, render, type as typeInto, waitFor } from '@/test/render';
import { clearDownloads, downloadedNames } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { CommandPalette } from './CommandPalette';
import { buildPanelCommands } from './commandPaletteCommandsPanels';
import { RECENT_KEY } from './commandPaletteSearch';
import { RibbonExportGroup } from './ribbon/tabs/RibbonExportGroup';
import { type ExportIconSet } from './toolbar/export-commands';

const sdk = createBimContext({ transport: {
  send: () => Promise.reject(new Error('SDK transport is outside this regression')),
  subscribe: () => () => {}, close: () => {},
} });
const result: RuntimeRunResult = { value: undefined, logs: [], durationMs: 0 };
const owner = 'com.regression.runtime-refusal';
const command: SlotContribution<CommandContribution> = {
  extensionId: owner, slot: 'commandPalette',
  payload: { id: 'runtime-refusal', title: 'Runtime refusal command' },
};
const exporter: ExporterContribution = {
  id: 'runtime-export', name: 'Runtime refusal export', extension: 'csv',
  mimeType: 'text/csv', handler: 'export.js',
};

// Real host, dispatcher and SlotRegistry; only the execution boundaries are replaced.
class BoundaryHost extends ExtensionHostService {
  readonly commands: string[] = [];
  readonly exports: string[] = [];
  private releases: Array<() => void> = [];
  constructor() { super({ sdk }); }
  override async runCommand(id: string, extensionId: string) {
    this.commands.push(`${extensionId}:${id}`);
    return result;
  }
  override runExporter(id: string, extensionId: string): Promise<ExporterOutput> {
    this.exports.push(`${extensionId}:${id}`);
    return new Promise(resolve => {
      this.releases.push(() => resolve({ contribution: exporter, data: 'column\nvalue\n', result }));
    });
  }
  releaseExports() { for (const release of this.releases.splice(0)) release(); }
}

const original = useViewerStore.getState();
const originalFrame = globalThis.requestAnimationFrame;
const hosts: BoundaryHost[] = [];
const executions: string[] = [];
const frames: FrameRequestCallback[] = [];
function host() { const value = new BoundaryHost(); hosts.push(value); return value; }
function holdFrames() {
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
}
async function flushFrames() {
  assert.ok(frames.length > 0, 'a real activation frame was scheduled');
  await act(async () => { for (const frame of frames.splice(0)) frame(0); });
}
function noUsage() {
  assert.deepEqual(executions, [], 'refused activation emits no command_executed event');
  assert.equal(localStorage.getItem(RECENT_KEY), null, 'refused activation creates no recent command');
}
function row(title: string) {
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .filter(option => option.textContent?.includes(title));
  assert.equal(rows.length, 1, `one runtime row titled ${title}`);
  return rows[0];
}
function search(title: string) {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
  assert.ok(input);
  typeInto(input, title);
  return input;
}
function mount(initialHost: BoundaryHost, ribbon = false) {
  let changeHost: Dispatch<SetStateAction<BoundaryHost | null>> | undefined;
  let closes = 0;
  function Surface() {
    const [currentHost, setHost] = useState<BoundaryHost | null>(initialHost);
    changeHost = setHost;
    return <BimReactContext.Provider value={sdk}>
      <ExtensionHostContext.Provider value={currentHost}><TooltipProvider>
        {ribbon && <RibbonExportGroup icons={icons} />}
        <CommandPalette open onOpenChange={() => { closes++; }} />
      </TooltipProvider></ExtensionHostContext.Provider>
    </BimReactContext.Provider>;
  }
  render(<Surface />);
  return {
    replace(next: BoundaryHost | null) { act(() => { assert.ok(changeHost); changeHost(next); }); },
    get closes() { return closes; },
  };
}
const icons: ExportIconSet = {
  ifc: Puzzle, anonymized: Puzzle, 'modified-ifc': Puzzle, glb: Puzzle, kmz: Puzzle,
  ion: Puzzle, usd: Puzzle, energy: Puzzle, 'landxml-terrain': Puzzle, csv: Puzzle,
  json: Puzzle, screenshot: Puzzle, pdf: Puzzle, extension: Puzzle,
};

beforeEach(() => {
  setLocale('en');
  localStorage.clear();
  clearDownloads();
  executions.length = 0;
  frames.length = 0;
  useActivityJournal.setState({ jobs: [] });
  useViewerStore.setState({ ...fixtureModels(fixtureModel('runtime-model')), collabRole: null, loading: false });
  mock.method(posthog, 'capture', (event: string) => {
    if (event === 'command_executed') executions.push(event);
  });
});
afterEach(async () => {
  globalThis.requestAnimationFrame = originalFrame;
  frames.length = 0;
  // Also drain on assertion failure: never leave an export or its busy lock behind.
  await act(async () => {
    for (const value of hosts) value.releaseExports();
  });
  await waitFor(() => useActivityJournal.getState().jobs.every(job => job.outcome !== 'running'),
    'all started exports finish before teardown', 2_000);
  cleanup();
  for (const value of hosts.splice(0)) await value.dispose();
  mock.restoreAll();
  useViewerStore.setState(original, true);
  useActivityJournal.setState({ jobs: [] });
  localStorage.clear();
  clearDownloads();
});

for (const transition of ['removed', 'replaced'] as const) {
  test(`#8947 provider ${transition} after click refuses deferred runtime activation before usage`, async () => {
    const oldHost = host();
    oldHost.slotRegistry.register(owner, [command]);
    const replacement = transition === 'replaced' ? host() : null;
    replacement?.slotRegistry.register(owner, [command]);
    const surface = mount(oldHost);
    search(command.payload.title);
    assert.equal(row(command.payload.title).getAttribute('aria-disabled'), null);
    holdFrames();
    click(row(command.payload.title));
    assert.equal(surface.closes, 1, 'the enabled click reached the activation path');
    noUsage();
    surface.replace(replacement);
    await flushFrames();
    assert.deepEqual(oldHost.commands, [], 'retired host is never executed');
    assert.deepEqual(replacement?.commands ?? [], [], 'replacement cannot inherit the stale click');
    noUsage();

    // Positive control: the same mounted palette can execute a fresh current row.
    const current = replacement ?? oldHost;
    surface.replace(current);
    click(row(command.payload.title));
    await flushFrames();
    await waitFor(() => current.commands.length === 1, 'fresh runtime command reaches the host', 2_000);
    assert.deepEqual(current.commands, [`${owner}:${command.payload.id}`]);
    assert.equal(executions.length, 1);
    assert.deepEqual(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'), [row(command.payload.title).dataset.runtimeCommandId]);
  });
}

// The early palette bridge awaits the real dispatcher before handing off to the host.
// These regressions exercise retirement during that await (review4500142199).
for (const transition of ['removed', 'replaced', 'contribution-removed'] as const) {
  test(`#8947 ${transition} during dispatcher activation refuses the stale host handoff`, async () => {
    const oldHost = host();
    oldHost.slotRegistry.register(owner, [command]);
    oldHost.dispatcher.register(owner, [`onCommand:${command.payload.id}`]);
    const replacement = transition === 'replaced' ? host() : null;
    replacement?.slotRegistry.register(owner, [command]);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let activating = false;
    const unsubscribe = oldHost.dispatcher.onActivate(async () => {
      activating = true;
      await pending;
    });
    const notices: string[] = [];
    mock.method(toast, 'info', (message: string) => { notices.push(message); });
    const surface = mount(oldHost);
    search(command.payload.title);
    holdFrames();
    try {
      click(row(command.payload.title));
      await flushFrames();
      await waitFor(() => activating, 'real dispatcher is waiting for activation', 2_000);
      assert.deepEqual(oldHost.commands, [], 'host execution has not begun');
      assert.equal(executions.length, 1, 'accepted click retains the established usage contract');
      const recentAtAcceptance = localStorage.getItem(RECENT_KEY);
      assert.ok(recentAtAcceptance);
      if (transition === 'contribution-removed') {
        act(() => oldHost.slotRegistry.unregister(owner));
      } else surface.replace(replacement);
      await act(async () => release());
      await waitFor(() => notices.length === 1, 'retirement is reported after activation settles', 2_000);
      assert.ok(notices[0].length > 0, 'refusal is visible, not a silent no-op');
      assert.deepEqual(oldHost.commands, [], 'retired provider or contribution never runs');
      assert.deepEqual(replacement?.commands ?? [], [], 'replacement cannot inherit the stale click');
      assert.equal(executions.length, 1, 'retirement creates no second usage event');
      assert.equal(localStorage.getItem(RECENT_KEY), recentAtAcceptance);

      // A fresh current contribution still executes after the refused handoff.
      const current = replacement ?? oldHost;
      act(() => current.slotRegistry.register(owner, [command]));
      surface.replace(current);
      click(row(command.payload.title));
      await flushFrames();
      await waitFor(() => current.commands.length === 1, 'fresh current provider executes', 2_000);
      assert.deepEqual(current.commands, [`${owner}:${command.payload.id}`]);
      assert.equal(executions.length, 2);
    } finally {
      release();
      unsubscribe();
      await act(async () => { await pending; });
    }
  });
}

test('#8947 null-host builder explicitly disables a retained runtime contribution', () => {
  const rows = buildPanelCommands({
    execute: () => {}, recentFiles: [], cachedNames: { current: new Set<string>() },
    extensionCommands: [command], extensionHost: null, canEditInSession: true,
    cesiumAvailable: false, activateRightPanel: () => {}, activateBottomPanel: () => {}, runExport: () => {},
  });
  const runtime = rows.find(entry => entry.runtimeSource === 'extension-command' && entry.label === command.payload.title);
  assert.ok(runtime, 'retained contribution remains discoverable');
  assert.deepEqual(runtime.availability, { status: 'disabled', reasonKey: 'commandPalette.availability.host' });
  assert.deepEqual(runtime.checkAvailability?.(), runtime.availability);
  noUsage();
});

test('#8947 pending ribbon export refuses deferred and subsequent palette activation before usage', async () => {
  const service = host();
  service.slotRegistry.register(owner, [{ extensionId: owner, slot: 'exportMenu', payload: exporter }]);
  const surface = mount(service, true);
  const input = search(exporter.name);
  assert.equal(row(exporter.name).getAttribute('aria-disabled'), null);
  holdFrames();
  click(row(exporter.name));
  assert.equal(surface.closes, 1);
  const ribbon = document.querySelector<HTMLButtonElement>('[data-export-extension]');
  assert.ok(ribbon, 'real ribbon exporter is mounted alongside the palette');
  click(ribbon);
  try {
    await waitFor(() => service.exports.length === 1, 'ribbon export reaches the pending boundary', 2_000);
    assert.equal(useActivityJournal.getState().jobs[0]?.outcome, 'running');
    assert.equal(downloadedNames().length, 0, 'the first export is genuinely pending');
    await flushFrames();
    assert.equal(service.exports.length, 1, 'queued palette export cannot start a second run');
    noUsage();
    assert.equal(row(exporter.name).getAttribute('aria-disabled'), 'true');
    click(row(exporter.name));
    press(input, 'Enter');
    assert.equal(surface.closes, 1, 'busy clicks and Enter refuse before dismissal');
    assert.equal(service.exports.length, 1);
    noUsage();
  } finally {
    await act(async () => service.releaseExports());
    await waitFor(() => useActivityJournal.getState().jobs.every(job => job.outcome !== 'running'),
      'first export drains after release', 2_000);
  }
  assert.equal(downloadedNames().length, 1, 'the accepted ribbon export publishes exactly once');
  assert.equal(row(exporter.name).getAttribute('aria-disabled'), null, 'completion releases shared busy state');
  noUsage();
});
