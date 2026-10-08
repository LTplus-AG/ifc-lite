/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore, type AuthoringOverlayChannel } from '@/store';
import { GROUND_STOREY, PLUMBING_WALL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { modelChangeLibrary, useModelChangeReceipts } from '@/lib/actions/receipts';
import { parseIDS } from '@ifc-lite/ids';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { runIdsCheck } from '@/lib/validation/run-ids-check';
import { sampleIdsXml } from '@/test/sample-corrections-fixture';
import { ModelAuthoringReview } from './ModelAuthoringReview';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original); });

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.ok(check());
}

test('the authoring card gates on Edit mode, excludes dependent rows, previews ghosts, applies once and undoes from the receipt', async () => {
  await modelChangeLibrary.initialize();
  const { view } = await seedAuthoringSample({ editEnabled: false });
  const uploads: Array<[AuthoringOverlayChannel, MeshData[]]> = [];
  const cleared: AuthoringOverlayChannel[] = [];
  useViewerStore.setState({ cameraCallbacks: { ...useViewerStore.getState().cameraCallbacks,
    setAuthoringOverlayMeshes: (channel, meshes) => { uploads.push([channel, meshes]); },
    clearAuthoringOverlayMeshes: (channel) => { cleared.push(channel); } } });
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Annex', units: 'mm', frame: 'storey-local', operations: [
    { op: 'element.create', ref: 'wall-a', ifcClass: 'IfcWall', storey: { globalId: GROUND_STOREY }, name: 'Annex south',
      params: { start: [10000, 10000, 0], end: [14000, 10000, 0], thickness: 200, height: 3000 } },
    { op: 'hosted.create', kind: 'door', host: { ref: 'wall-a' }, offset: 2000, sill: 0, width: 900, height: 2100 },
    { op: 'element.delete', target: { globalId: PLUMBING_WALL, ifcClass: 'IfcWall', name: 'plumbing wall' } },
    { op: 'element.delete', target: { globalId: PLUMBING_WALL, ifcClass: 'IfcSlab', name: 'plumbing wall' } },
  ] }));
  const ui = render(<ModelAuthoringReview batch={batch} origin="test" />);
  const button = (text: string) => [...ui.querySelectorAll('button')].find(b => b.textContent?.startsWith(text));
  const boxes = () => [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

  assert.equal(button('Apply')?.disabled, true, 'nothing is applicable while edits are denied');
  assert.match(ui.textContent ?? '', /Lengths in mm, storey-local/);
  click(button('Turn on Edit mode')!);
  assert.equal(button('Apply')?.textContent, 'Apply 3 operations');
  assert.match(ui.textContent ?? '', /Create IfcWall "Annex south"/);
  assert.match(ui.textContent ?? '', /on 00 groundfloor: \(10000, 10000, 0\) → \(14000, 10000, 0\) · 200 × 3000 mm/);
  assert.match(ui.textContent ?? '', /Expected IfcSlab "plumbing wall"; the model has IfcWall "plumbing wall"/, 'the conflict says what changed');
  assert.equal(boxes()[3].disabled, true);

  act(() => boxes()[0].click());
  assert.equal(button('Apply')?.textContent, 'Apply 1 operation', 'excluding the wall excludes the door placed in it');
  assert.equal(boxes()[1].checked, false);
  act(() => boxes()[0].click());

  click(button('Preview in 3D')!);
  const shown = uploads.filter(([channel]) => channel === 'proposal').at(-1);
  assert.ok(shown && shown[1].length === 2, 'the new wall and the door are ghosted on the proposal channel');
  assert.equal(button('Hide 3D preview')?.getAttribute('aria-pressed'), 'true');
  assert.equal(view.getNewEntities().length, 0, 'previewing writes nothing');

  click(button('Apply')!);
  assert.match(ui.textContent ?? '', /Applied 3 changes as one undo step/);
  assert.ok(cleared.includes('proposal'), 'applying clears the preview');
  assert.ok(view.getNewEntities().some((entity) => entity.type === 'IfcWall'));
  assert.equal(view.isDeleted(useViewerStore.getState().models.get('arch')!.ifcDataStore!.entities.getExpressIdByGlobalId(PLUMBING_WALL)), true);
  await waitFor(() => useModelChangeReceipts.getState().entries.some((entry) => entry.kind === 'model.authoring'));

  click(button('Undo these changes')!);
  await waitFor(() => useModelChangeReceipts.getState().entries.find((entry) => entry.kind === 'model.authoring')?.status === 'undone');
  assert.equal(view.getNewEntities().some((entity) => entity.type === 'IfcWall'), false, 'undo removes the created wall');
});

// #6912: reviewed authoring receipts record the loaded check's counts too, so Re-run validation is offered for them.
test('an authoring apply records the loaded validation baseline on its receipt', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, view } = await seedAuthoringSample();
  const state = useViewerStore.getState();
  const { report, snapshot } = await runIdsCheck({ document: parseIDS(await sampleIdsXml()), modelId: 'arch', dataStore, mutationView: view,
    locale: 'en', models: state.models });
  state.setIdsValidationReport(stampAnalysisReport(report, captureAnalysisStamp()), snapshot);
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Remove plumbing wall', units: 'mm',
    frame: 'storey-local', operations: [{ op: 'element.delete', target: { globalId: PLUMBING_WALL, ifcClass: 'IfcWall', name: 'plumbing wall' } }] }));
  const ui = render(<ModelAuthoringReview batch={batch} origin="test" />);
  click([...ui.querySelectorAll('button')].find(b => b.textContent?.startsWith('Apply'))!);
  await waitFor(() => useModelChangeReceipts.getState().entries.some((entry) => entry.title === 'Remove plumbing wall'));
  const receipt = useModelChangeReceipts.getState().entries.find((entry) => entry.title === 'Remove plumbing wall');
  assert.equal(receipt?.validation?.source, 'ids');
  assert.equal(receipt?.validation?.beforeFreshness, 'current');
  assert.ok((receipt?.validation?.before.length ?? 0) > 0, 'per-specification counts at apply');
});
