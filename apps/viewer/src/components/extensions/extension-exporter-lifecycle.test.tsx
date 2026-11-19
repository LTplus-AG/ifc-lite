/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { act, useState } from 'react';
import { cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { PaletteCommandTestHost } from '@/components/viewer/__fixtures__/palette-extension-command';
import { buildExportCommands } from '@/components/viewer/commandPaletteExports';
import type { ExporterOutput } from '@/services/extensions/host-exporters';
import { setLocale } from '@/i18n';
import { Toaster } from '@/components/ui/toast';
import { useExtensionExporters } from './useExtensionExporters';

class Host extends PaletteCommandTestHost {
  readonly runs: string[] = [];
  complete?: (output: ExporterOutput) => void;
  override runExporter(id: string, owner: string): Promise<ExporterOutput> {
    this.runs.push(`${owner}:${id}`);
    return new Promise(resolve => { this.complete = resolve; });
  }
}
const payload = { id: 'report', name: 'Report', extension: 'txt', mimeType: 'text/plain', handler: 'report.js' };
function add(host: Host, owner = 'alpha') {
  host.slotRegistry.register(owner, [{ extensionId: owner, slot: 'exportMenu', payload: { ...payload } }]);
}
let api: ReturnType<typeof useExtensionExporters>;
let secondary: ReturnType<typeof useExtensionExporters>;
beforeEach(() => setLocale('en'));
function Harness() { api = useExtensionExporters('palette'); secondary = useExtensionExporters('mobile'); return <Toaster />; }
const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original); });

test('#8947 captured export rows refuse slot replacement and provider replacement before invoking host', async () => {
  const host = new Host(); add(host); add(host, 'beta');
  const next = new Host(); add(next);
  let replace: () => void = () => { throw new Error('not mounted'); };
  function Switch() {
    const [current, setCurrent] = useState(host); replace = () => setCurrent(next);
    return <ExtensionHostContext.Provider value={current}><Harness /></ExtensionHostContext.Provider>;
  }
  render(<Switch />);
  const captured = api!;
  const rows = buildExportCommands(() => {}, captured.exporters).filter(row => row.runtimeSource === 'extension-export');
  assert.equal(new Set(rows.map(row => row.id)).size, 2);
  assert.match(rows[1].detail ?? '', /beta/);
  act(() => { host.slotRegistry.unregister('alpha'); add(host); });
  assert.equal(rows[0].checkAvailability?.().status, 'disabled');
  await act(async () => { await captured.runExtensionExporter('alpha:report'); });
  assert.deepEqual(host.runs, []);
  const oldProvider = api!;
  act(replace);
  await act(async () => { await oldProvider.runExtensionExporter('alpha:report'); });
  assert.deepEqual(host.runs, []); assert.deepEqual(next.runs, []);
  // The unregistered case resolves through visible error UI, never a rejected void promise.
  await act(async () => { await api!.runExtensionExporter('missing:report'); });
  assert.match(document.body.textContent ?? '', /Unregistered extension exporter/);
});

test('#8947 exporters work without a model, report busy live, and keep invocation model name during asynchronous download', async () => {
  const host = new Host(); add(host);
  useViewerStore.setState(fixtureModels());
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  assert.equal(api!.exporters[0].checkAvailability?.().status, 'available');
  const model = fixtureModel('first'); model.name = 'First.ifc';
  act(() => useViewerStore.setState(fixtureModels(model)));
  let download = '';
  const observer = (event: Event) => {
    if (event.target instanceof HTMLAnchorElement) { event.preventDefault(); download = event.target.download; }
  };
  document.addEventListener('click', observer);
  const create = URL.createObjectURL; const revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:fixture'; URL.revokeObjectURL = () => {};
  try {
    let pending: Promise<void> | undefined;
    act(() => { pending = api!.runExtensionExporter('alpha:report'); });
    assert.deepEqual(host.runs, ['alpha:report']);
    assert.equal(api!.exporters[0].checkAvailability?.().status, 'disabled');
    assert.equal(secondary!.exporters[0].checkAvailability?.().status, 'disabled');
    await act(async () => { await secondary!.runExtensionExporter('alpha:report'); });
    await act(async () => { await api!.runExtensionExporter('alpha:report'); });
    assert.deepEqual(host.runs, ['alpha:report']);
    const changed = fixtureModel('second'); changed.name = 'Second.ifc';
    act(() => useViewerStore.setState(fixtureModels(changed)));
    await act(async () => {
      host.complete?.({ contribution: payload, data: 'contents', result: { value: undefined, logs: [], durationMs: 0 } });
      await pending;
    });
    assert.equal(download, 'First.txt');
    assert.equal(api!.exporters[0].checkAvailability?.().status, 'available');
  } finally { document.removeEventListener('click', observer); URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});
