/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { render, cleanup, click, waitFor } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { tabularFixtureStore } from '@/test/tabular-store-fixture';
import { ExportDialog } from './ExportDialog';

afterEach(() => { cleanup(); clearDownloads(); mock.restoreAll(); });

test('IFC export of a store with no STEP records reports the refusal by name and downloads nothing (#10045)', async () => {
  const model = { ...fixtureModel('tabular.3dm'), ifcDataStore: tabularFixtureStore(), schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ ...fixtureModels(model), activeModelId: model.id, dirtyModels: new Set() });
  const errors: string[] = [];
  mock.method(toast, 'error', (message: string) => { errors.push(message); });
  const success = mock.method(toast, 'success', () => undefined);
  const ui = render(<ExportDialog surface="ribbon" />);
  click([...ui.querySelectorAll('button')].find(button => button.textContent?.includes('Export IFC'))!);
  const action = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export');
  assert.ok(action && !action.disabled, 'the dialog offers the export');
  click(action);
  await waitFor(() => errors.length > 0 || success.mock.callCount() > 0, 'the export never reported');
  assert.deepEqual(errors, ['"tabular.3dm" has no IFC STEP records to export from. Export it on its own as IFC5 (IFCX).']);
  assert.equal(success.mock.callCount(), 0);
  assert.deepEqual(downloadedNames(), []);
});
