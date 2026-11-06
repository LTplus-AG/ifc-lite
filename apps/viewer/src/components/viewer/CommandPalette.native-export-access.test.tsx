/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { BimReactContext } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { getLocale, setLocale } from '@/i18n';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { EXPORTER, NativeExporterHost, nativeExporterHost, installNativeExporter } from '@/test/extension-export-fixture';
import { cleanup, click, press, render, type as typeInto, waitFor } from '@/test/render';
import { CommandPalette } from './CommandPalette';

// #8947: join the mounted palette to the existing packed-bundle QuickJS
// fixture (#7170). No exporter handler, native result, SDK query or hook is mocked.
// The parsed SketchUp sample is real IFC; its geometry is not meshed here.
const initial = useViewerStore.getState();
const locale = getLocale();
const originalObjectURL = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const originalClick = HTMLAnchorElement.prototype.click;
const hosts: NativeExporterHost[] = [];
beforeEach(() => {
  setLocale('en'); localStorage.clear();
  useActivityJournal.setState({ jobs: [] });
  useViewerStore.setState({ collabRole: null, canCollabEdit: () => true, loading: false });
});
afterEach(async () => {
  cleanup();
  for (const host of hosts.splice(0)) await host.dispose();
  useViewerStore.setState(initial, true);
  useActivityJournal.setState({ jobs: [] });
  setLocale(locale); localStorage.clear();
  URL.createObjectURL = originalObjectURL;
  URL.revokeObjectURL = originalRevoke;
  HTMLAnchorElement.prototype.click = originalClick;
});
function Harness({ sharedExtensionHostService }: { sharedExtensionHostService: NativeExporterHost }) {
  const [open, setOpen] = useState(false);
  // The palette's useExportCommands/useExtensionExporters and its slot
  // subscription see this SAME real host; no separate hook-only controls.
  return <BimReactContext.Provider value={sharedExtensionHostService.sdk}>
    <ExtensionHostContext.Provider value={sharedExtensionHostService}>
      <button onClick={() => setOpen(true)}>Commands</button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </ExtensionHostContext.Provider>
  </BimReactContext.Provider>;
}
function exporterRow(owner: string) {
  const row = document.querySelector<HTMLElement>(
    `[role="option"][data-command-id="export:ext:${owner}:${EXPORTER}"]`);
  assert.ok(row, `installed owner-qualified palette exporter: ${owner}`);
  return row;
}
function capturePublication() {
  const blobs: Blob[] = [];
  const publications: Array<{ filename: string; href: string; outcomes: string[] }> = [];
  URL.createObjectURL = blob => {
    assert.ok(blob instanceof Blob); blobs.push(blob);
    return `blob:palette-native-${blobs.length}`;
  };
  URL.revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = function () {
    publications.push({ filename: this.download, href: this.href,
      outcomes: useActivityJournal.getState().jobs.map(job => job.outcome) });
  };
  return { blobs, publications };
}
const expectedWalls = [
  { GlobalId: '1AQAupaRP1txwK1AGiN61V', Name: 'house - outer wall - house right front' },
  { GlobalId: '3wdauVJT5Fx9drrREiDqA$', Name: 'house - outer wall - house right back' },
  { GlobalId: '0OfZwWc8j9QP5uX8xPTxDH', Name: 'house - outer wall - house left' },
  { GlobalId: '1uS5vfZPn9R8PlAaVd73on', Name: 'plumbing wall' },
];

for (const activation of ['row', 'Enter'] as const) {
  test(`#8947 owner-qualified palette ${activation} runs installed native exporter through browser publication`, async () => {
    const sharedExtensionHostService = await nativeExporterHost(); hosts.push(sharedExtensionHostService);
    const otherOwner = `com.campaign.palette-native-other-${activation.toLowerCase()}`;
    const owner = `com.campaign.palette-native-target-${activation.toLowerCase()}`;
    await installNativeExporter(sharedExtensionHostService, otherOwner);
    await installNativeExporter(sharedExtensionHostService, owner);
    // Gate only delivery of the REAL result, as in useExtensionExporters.activity.
    // Release in finally even when the palette fails to reach native dispatch.
    let release: () => void = () => undefined;
    sharedExtensionHostService.gates.set(owner, new Promise<void>(resolve => { release = resolve; }));
    const { blobs, publications } = capturePublication();
    const ui = render(<Harness sharedExtensionHostService={sharedExtensionHostService} />);
    const launcher = ui.querySelector<HTMLButtonElement>('button')!;
    launcher.focus(); click(launcher);
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]'); assert.ok(input);
    typeInto(input, 'Native walls');
    const row = exporterRow(owner);
    assert.notEqual(row.getAttribute('aria-disabled'), 'true');
    assert.notEqual(exporterRow(otherOwner).getAttribute('aria-disabled'), 'true');
    try {
      if (activation === 'row') click(row);
      else {
        act(() => row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
        assert.equal(row.getAttribute('aria-selected'), 'true', 'Enter is aimed at the requested owner');
        press(input, 'Enter');
      }
      await waitFor(() => sharedExtensionHostService.delivered.has(owner),
        'palette dispatch reaches the actual installed QuickJS handler');
      assert.equal(sharedExtensionHostService.delivered.has(otherOwner), false,
        'duplicate exporter ID cannot dispatch the other owner');
      assert.equal(document.querySelector('input[role="combobox"]'), null);
      const jobs = useActivityJournal.getState().jobs;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].outcome, 'running');
      assert.ok(jobs[0].subject?.includes(owner));
      assert.ok(!jobs[0].subject?.includes(otherOwner));
      assert.equal(blobs.length, 0, 'real native output is still before browser publication');
      assert.equal(publications.length, 0);
    } finally {
      await act(async () => { release(); });
      // Ensure teardown cannot dispose a running sandbox/export invocation.
      await waitFor(() => useActivityJournal.getState().jobs.every(job => job.outcome !== 'running'),
        'released exporter settles its Activity row');
    }
    await waitFor(() => publications.length === 1, 'actual native bytes reach the browser download boundary');
    assert.equal(blobs.length, 1);
    assert.equal(publications.length, 1);
    assert.deepEqual(publications[0].outcomes, ['running'], 'completion follows publication, never precedes it');
    assert.match(publications[0].filename, /building-architecture\.json$/);
    assert.equal(publications[0].href, 'blob:palette-native-1');
    const output = JSON.parse(await blobs[0].text()) as { owner: string; walls: typeof expectedWalls };
    assert.equal(output.owner, owner);
    assert.equal(output.walls.length, 4);
    assert.equal(new Set(output.walls.map(wall => wall.GlobalId)).size, 4);
    assert.deepEqual([...output.walls].sort((a, b) => a.GlobalId.localeCompare(b.GlobalId)),
      [...expectedWalls].sort((a, b) => a.GlobalId.localeCompare(b.GlobalId)),
      'real native query preserves the committed SketchUp wall identities and names');
    const jobs = useActivityJournal.getState().jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].outcome, 'completed');
    assert.ok(jobs[0].subject?.includes(owner));
    assert.equal(sharedExtensionHostService.delivered.has(otherOwner), false);
    await waitFor(() => document.activeElement === launcher, 'palette returns focus to its launcher');
  });
}
