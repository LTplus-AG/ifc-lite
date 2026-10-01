/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { before, afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { render, click, type, cleanup, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { parseFixtureModel, FIXTURE_WALL_A } from './anonymized-export/anonymized-export-fixture.test-support';
import { CesiumIonExportDialog } from './CesiumIonExportDialog';
import { initializeIonExportWasm } from './CesiumIonExportDialog.wasm.test-support';

before(initializeIonExportWasm);
import { IonUploadError, type IonUploadInput } from '@/lib/geo/cesium-ion-upload';

import { modelAppearanceAssets } from '@/lib/appearance/model-assets';

afterEach(() => { cleanup(); mock.restoreAll(); });
const button = (text: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text)!;

test('ion dialog defaults to active IFC, uploads edited bytes, and forgets write token on close (#6587)', async () => {
  const dataStore = await parseFixtureModel();
  const scan = fixtureModel('first.ifc');
  const model = { ...fixtureModel('active.ifc'), ifcDataStore: dataStore, schemaVersion: 'IFC4' as const };
  const view = new MutablePropertyView(dataStore.properties ?? null, model.id);
  configureMutationView(view, dataStore);
  view.setAttribute(FIXTURE_WALL_A, 'Name', 'Upload edit', 'Wall A');
  useViewerStore.setState({ ...fixtureModels(scan, model), activeModelId: model.id, mutationViews: new Map([[model.id, view]]),
    georefMutations: new Map(), scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  let sent: IonUploadInput | undefined;
  render(<CesiumIonExportDialog surface="ribbon" upload={async input => { sent = input; return { assetId: 42 }; }} />);
  click(button('Upload to Cesium ion'));
  assert.match(document.querySelector('[role="combobox"]')?.textContent ?? '', /active.ifc/);
  const token = document.querySelector<HTMLInputElement>('#ion-token')!;
  assert.equal(token.type, 'password');
  type(token, 'private-test-token');
  click(button('Upload'));
  await waitFor(() => !!sent, 'upload was not invoked');
  const exported = await new IfcParser().parseColumnar(sent!.bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  assert.equal(exported.entities.getName(FIXTURE_WALL_A), 'Upload edit');
  assert.equal(sent!.fileName, 'active.ifc');
  await waitFor(() => !!document.querySelector('a[href="https://ion.cesium.com/assets/42"]'), 'asset link missing');
  assert.ok(document.body.textContent?.includes('Submitted for tiling'));
  assert.equal(document.querySelector('a[href="https://ion.cesium.com/assets/42"]')?.textContent?.trim(), 'View active in Cesium ion');
  click(button('Close'));
  click(button('Upload to Cesium ion'));
  assert.equal(document.querySelector<HTMLInputElement>('#ion-token')!.value, '');
  assert.equal(button('Upload').disabled, true);
  assert.equal(document.querySelector('a[href="https://ion.cesium.com/assets/42"]'), null);
});


test('ion refuses image-bearing IFC before creating a remote asset (#6587)', async () => {
  const model = { ...fixtureModel('textured.ifc'), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map(), georefMutations: new Map(),
    scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  mock.method(modelAppearanceAssets, 'exportOriginals', () => ({ resources: new Map([['texture.png', new Uint8Array([1])]]) }));
  render(<CesiumIonExportDialog surface="ribbon" upload={async () => assert.fail('must not create asset or lose texture')} />);
  click(button('Upload to Cesium ion'));
  type(document.querySelector<HTMLInputElement>('#ion-token')!, 'private-test-token');
  click(button('Upload'));
  await waitFor(() => !!document.body.textContent?.includes('Direct texture upload is not supported'), 'texture refusal missing');
  assert.ok(document.body.textContent?.includes('Upload did not complete'));
});


test('ion Cancel upload aborts the active request and exposes the partial asset (#6587)', async () => {
  const model = { ...fixtureModel('cancel.ifc'), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map(), georefMutations: new Map(),
    scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  let started: IonUploadInput | undefined;
  render(<CesiumIonExportDialog surface="ribbon" upload={async input => {
    started = input;
    return new Promise<{ assetId: number }>((_, reject) => {
      input.signal.addEventListener('abort', () => reject(new IonUploadError('upload', 77)), { once: true });
    });
  }} />);
  click(button('Upload to Cesium ion'));
  type(document.querySelector<HTMLInputElement>('#ion-token')!, 'private-test-token');
  click(button('Upload'));
  await waitFor(() => !!started, 'upload did not start');
  assert.equal(button('Close').disabled, true);
  click(button('Cancel upload'));
  await waitFor(() => !!document.body.textContent?.includes('Upload cancelled'), 'cancellation was not reported');
  assert.equal(started!.signal.aborted, true);
  assert.ok(document.querySelector('a[href="https://ion.cesium.com/assets/77"]'));
  assert.equal(button('Upload').disabled, false, 'the user can retry after cancellation');
});

test('ion shows request rejection without blaming token permissions and supports retry (#6587)', async () => {
  const model = { ...fixtureModel('retry.ifc'), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map(), georefMutations: new Map(),
    scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  let attempts = 0;
  render(<CesiumIonExportDialog surface="ribbon" upload={async () => {
    if (++attempts === 1) throw new IonUploadError('create', undefined, 409);
    return { assetId: 88 };
  }} />);
  click(button('Upload to Cesium ion'));
  type(document.querySelector<HTMLInputElement>('#ion-token')!, 'private-test-token');
  click(button('Upload'));
  await waitFor(() => !!document.body.textContent?.includes('HTTP 409'), 'request rejection was not reported');
  assert.ok(document.body.textContent?.includes('Cesium ion rejected the upload request'));
  assert.ok(!document.body.textContent?.includes('Check the token permissions'));
  assert.equal(button('Upload').disabled, false);
  click(button('Upload'));
  await waitFor(() => !!document.querySelector('a[href="https://ion.cesium.com/assets/88"]'), 'retry asset link missing');
  assert.equal(attempts, 2);
  assert.ok(document.body.textContent?.includes('Submitted for tiling'));
  assert.equal(document.querySelector('a[href="https://ion.cesium.com/assets/88"]')?.textContent?.trim(), 'View retry in Cesium ion');
});

test('ion completion keeps a long asset name intact and accessible in the primary link (#6587)', async () => {
  const longName = 'Georeferencing_georeferenced-bridge-deck_model_with_a_long_unbroken_filename';
  const model = { ...fixtureModel(`${longName}.ifc`), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map(), georefMutations: new Map(),
    scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  render(<CesiumIonExportDialog surface="ribbon" upload={async () => ({ assetId: 99 })} />);
  click(button('Upload to Cesium ion'));
  type(document.querySelector<HTMLInputElement>('#ion-token')!, 'private-test-token');
  click(button('Upload'));
  await waitFor(() => !!document.querySelector('a[href="https://ion.cesium.com/assets/99"]'), 'primary asset link missing');
  const link = document.querySelector<HTMLAnchorElement>('a[href="https://ion.cesium.com/assets/99"]')!;
  assert.equal(link.textContent?.trim(), `View ${longName} in Cesium ion`);
  assert.equal(link.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
  assert.equal(link.target, '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});


test('ion partial recovery names the invocation-resolved export despite model changes (#6587)', async () => {
  const model = { ...fixtureModel('rendered.ifc'), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map(), georefMutations: new Map(),
    scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  let sent: IonUploadInput | undefined;
  let failUpload: ((error: IonUploadError) => void) | undefined;
  render(<CesiumIonExportDialog surface="ribbon" upload={async input => {
    sent = input;
    return new Promise<{ assetId: number }>((_, reject) => { failUpload = reject; });
  }} />);
  click(button('Upload to Cesium ion'));
  type(document.querySelector<HTMLInputElement>('#ion-token')!, 'private-test-token');
  // A model replacement can precede React's render: export resolves the current
  // store at invocation, while the old event handler still holds rendered.ifc.
  act(() => {
    useViewerStore.setState({ models: new Map([[model.id, { ...model, name: 'exported.ifc' }]]) });
    button('Upload').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await waitFor(() => !!sent && !!failUpload, 'upload did not start');
  assert.equal(sent!.fileName, 'exported.ifc');
  assert.equal(sent!.name, 'exported');
  const parsed = await new IfcParser().parseColumnar(sent!.bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  assert.equal(parsed.entities.getName(FIXTURE_WALL_A), 'Wall A');
  act(() => {
    const other = { ...model, id: 'other', name: 'other.ifc' };
    useViewerStore.setState({ models: new Map([[model.id, { ...model, name: 'renamed-after-upload.ifc' }], [other.id, other]]), activeModelId: other.id });
    failUpload!(new IonUploadError('upload', 101));
  });
  await waitFor(() => !!document.querySelector('a[href="https://ion.cesium.com/assets/101"]'), 'partial asset link missing');
  assert.equal(document.querySelector('a[href="https://ion.cesium.com/assets/101"]')?.textContent?.trim(), 'View exported in Cesium ion');
});
