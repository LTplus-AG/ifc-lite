/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ExportDialog } from './ExportDialog';

afterEach(cleanup);

test('Export IFC opens on the active authored model, not the first loaded scan (#4477)', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('scan.glb'), fixtureModel('captured.ifc')), activeModelId: 'captured.ifc', dirtyModels: new Set() });
  const ui = render(<ExportDialog />);
  click([...ui.querySelectorAll('button')].find(button => button.textContent?.includes('Export IFC'))!);
  const choices = [...document.querySelectorAll('[role="combobox"]')].map(node => node.textContent ?? '');
  assert.ok(choices.some(text => text.includes('captured.ifc')), `model selector shows the destination: ${JSON.stringify(choices)}`);
  assert.ok(!choices.some(text => text.includes('scan.glb')), 'the source scan is not the default export');
});
