/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { render, cleanup, click, waitFor } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { ExportDialog } from './ExportDialog';

afterEach(() => { cleanup(); clearDownloads(); mock.restoreAll(); });

test('Export IFC opens on the active authored model, not the first loaded scan (#4477)', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('scan.glb'), fixtureModel('captured.ifc')), activeModelId: 'captured.ifc', dirtyModels: new Set() });
  const ui = render(<ExportDialog />);
  click([...ui.querySelectorAll('button')].find(button => button.textContent?.includes('Export IFC'))!);
  const choices = [...document.querySelectorAll('[role="combobox"]')].map(node => node.textContent ?? '');
  assert.ok(choices.some(text => text.includes('captured.ifc')), `model selector shows the destination: ${JSON.stringify(choices)}`);
  assert.ok(!choices.some(text => text.includes('scan.glb')), 'the source scan is not the default export');
});

test('the authored IFC registry export downloads once and attributes each initiating surface (#5844)', async () => {
  const ifcDataStore = await parseFixtureModel();
  const model = { ...fixtureModel('captured.ifc'), ifcDataStore, schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ ...fixtureModels(model), activeModelId: model.id, dirtyModels: new Set() });
  const completions: Record<string, unknown>[] = [];
  mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
    if (event === 'export_completed') completions.push(properties);
  });
  for (const [index, surface] of (['classic', 'ribbon', 'palette'] as const).entries()) {
    const ui = render(<ExportDialog surface={surface} />);
    const trigger = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Export IFC'));
    assert.ok(trigger);
    click(trigger);
    const action = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Export');
    assert.ok(action && !action.disabled, 'authored IFC has an enabled Export action');
    click(action);
    await waitFor(() => downloadedNames().length === index + 1, 'authored IFC export did not download');
    assert.match(downloadedNames()[index], /\.ifc$/);
    assert.equal(completions.length, index + 1, 'one completion per downloaded IFC file');
    assert.equal(completions[index].format, 'ifc');
    assert.equal(completions[index].surface, surface);
    cleanup();
  }
});
