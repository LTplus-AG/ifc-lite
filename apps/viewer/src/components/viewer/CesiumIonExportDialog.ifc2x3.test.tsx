/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { render, click, type, cleanup, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import type { IonUploadInput } from '@/lib/geo/cesium-ion-upload';
import { CesiumIonExportDialog } from './CesiumIonExportDialog';

afterEach(cleanup);
const button = (text: string) => {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text);
  assert.ok(found, `Missing button: ${text}`);
  return found;
};

test('mounted ion caller exports edited authored IFC2X3 without applying IFC4-only map normalization or upconverting (#6624)', async context => {
  let source: Uint8Array;
  try {
    source = new Uint8Array(await readFile(new URL('../../../../../tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc', import.meta.url)));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      context.skip('Authored ISSUE_129 IFC2X3 fixture missing; run pnpm fixtures'); return;
    }
    throw error;
  }
  const parser = new IfcParser();
  const dataStore = await parser.parseColumnar(source.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  assert.equal(dataStore.schemaVersion, 'IFC2X3', 'the catalogued authoring-tool file must actually exercise IFC2X3');
  const expressId = dataStore.entityIndex.byType.get('IFCWALLSTANDARDCASE')?.[0]
    ?? dataStore.entityIndex.byType.get('IFCWALL')?.[0];
  assert.ok(expressId, 'the authored model has a real wall to edit');
  const originalName = dataStore.entities.getName(expressId);
  const originalGlobalId = dataStore.entities.getGlobalId(expressId);
  assert.ok(originalGlobalId, 'the real edited IFC root has a GlobalId');
  const model = { ...fixtureModel('IFC2X3-issue-129.ifc'), ifcDataStore: dataStore, schemaVersion: 'IFC2X3' as const };
  const view = new MutablePropertyView(dataStore.properties ?? null, model.id);
  configureMutationView(view, dataStore);
  const editedName = 'IFC2X3 ion schema-preserving edit';
  view.setAttribute(expressId, 'Name', editedName, originalName ?? undefined);
  useViewerStore.setState({ ...fixtureModels(model), activeModelId: model.id, mutationViews: new Map([[model.id, view]]),
    georefMutations: new Map(), scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  let sent: IonUploadInput | undefined;
  // Replace the network transport only. The actual dialog/shared exporter
  // must reach it with edited IFC2X3 bytes, not refuse or convert the schema.
  render(<CesiumIonExportDialog surface="ribbon" upload={async input => { sent = input; return { assetId: 42 }; }} />);
  click(button('Upload to Cesium ion'));
  assert.match(document.querySelector('#ion-model')?.textContent ?? '', /IFC2X3-issue-129/);
  type(document.querySelector<HTMLInputElement>('#ion-token')!, 'private-test-token');
  click(button('Upload'));
  await waitFor(() => sent !== undefined, 'the real IFC2X3 serializer did not reach upload transport');
  assert.ok(sent); assert.equal(sent.fileName, 'IFC2X3-issue-129.ifc');
  const output = await parser.parseColumnar(sent.bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  assert.equal(output.schemaVersion, 'IFC2X3', 'upload retains the authored schema instead of an implicit conversion');
  assert.equal(output.entities.getName(expressId), editedName);
  assert.equal(output.entities.getGlobalId(expressId), originalGlobalId);
  assert.equal(output.entities.getTypeName(expressId), dataStore.entities.getTypeName(expressId));
  assert.equal(dataStore.entities.getName(expressId), originalName, 'export leaves the source store unchanged');
  assert.deepEqual(view.getAttributeMutationsForEntity(expressId), [{ name: 'Name', value: editedName }]);
  await waitFor(() => document.body.textContent?.includes('Submitted for tiling') === true, 'successful IFC2X3 submission was not reported');
});
