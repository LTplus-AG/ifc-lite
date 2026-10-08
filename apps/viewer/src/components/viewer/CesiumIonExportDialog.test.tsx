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
import { IonUploadError, uploadToCesiumIon, type IonUploadInput } from '@/lib/geo/cesium-ion-upload';

import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';
import { ActivityTrayList } from './activity/ActivityTrayList';
import { modelAppearanceAssets } from '@/lib/appearance/model-assets';

afterEach(() => { cleanup(); mock.restoreAll(); useActivityJournal.setState({ jobs: [] }); });
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
  const job = useActivityJournal.getState().jobs.at(-1)!;
  assert.ok(activityCanceller(job.id), '#7121 native Cancel is also available in Activity');
  click(button('Cancel upload'));
  await waitFor(() => !!document.body.textContent?.includes('Upload cancelled'), 'cancellation was not reported');
  assert.equal(started!.signal.aborted, true);
  assert.equal(useActivityJournal.getState().jobs.find(row => row.id === job.id)?.outcome, 'cancelled', '#7121 panel abort is Cancelled');
  assert.equal(activityCanceller(job.id), null);
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

// #7121: network/S3 boundaries are controlled; IFC serialization, the uploader,
// its post-upload abort checkpoint, and Activity's mounted action are native.
test('ion Activity Cancel drains native upload and an old callback cannot abort retry (#7121)', async () => {
  useActivityJournal.setState({ jobs: [] });
  const model = { ...fixtureModel('tray.ifc'), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map(), georefMutations: new Map(),
    scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  const sent: Array<{ signal: AbortSignal; bytes: Uint8Array; settle: () => void }> = [];
  let completed = 0;
  const fetchImpl: typeof fetch = async (url) => {
    if (String(url).endsWith('/uploadComplete')) { completed++; return new Response('{}'); }
    return new Response(JSON.stringify({ assetMetadata: { id: 901 },
      uploadLocation: { bucket: 'test', prefix: 'native/', accessKey: 'test', secretAccessKey: 'test', sessionToken: 'test' },
      onComplete: { url: 'https://api.cesium.com/v1/assets/901/uploadComplete', method: 'POST', fields: {} } }));
  };
  render(<><CesiumIonExportDialog surface="ribbon" upload={input => uploadToCesiumIon(input, { fetchImpl,
    putObject: ({ signal, bytes }) => new Promise<void>(settle => sent.push({ signal, bytes, settle })),
  })} /><ActivityTrayList /></>);
  click(button('Upload to Cesium ion'));
  type(document.querySelector<HTMLInputElement>('#ion-token')!, 'private-test-token');
  click(button('Upload'));
  await waitFor(() => sent.length === 1, 'native upload entered S3 boundary');
  const parsed = await new IfcParser().parseColumnar(sent[0].bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  assert.equal(parsed.entities.getName(FIXTURE_WALL_A), 'Wall A', 'actual IFC serialization reaches transport');
  const first = useActivityJournal.getState().jobs.at(-1)!;
  const oldCancel = activityCanceller(first.id);
  assert.ok(oldCancel);
  const trayCancel = document.querySelector<HTMLButtonElement>('button[aria-label="Cancel Export"]');
  assert.ok(trayCancel, 'mounted Activity offers native cancellation');
  click(trayCancel);
  assert.equal(sent[0].signal.aborted, true);
  assert.equal(button('Close').disabled, true, 'non-abortable external transport drains before retry');
  await act(async () => sent[0].settle());
  await waitFor(() => useActivityJournal.getState().jobs[0]?.outcome === 'cancelled', 'native cancellation settled');
  assert.equal(completed, 0, 'native checkpoint suppresses late upload completion');
  assert.equal(activityCanceller(first.id), null);
  assert.ok(document.querySelector('a[href="https://ion.cesium.com/assets/901"]'), 'partial remote asset remains visible');
  click(button('Upload'));
  await waitFor(() => sent.length === 2, 'retry entered native upload');
  oldCancel();
  assert.equal(sent[1].signal.aborted, false, 'old invocation cannot abort retry');
  await act(async () => sent[1].settle());
  await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed', 'retry completed');
  assert.equal(completed, 1);
  assert.equal(activityCanceller(useActivityJournal.getState().jobs.at(-1)!.id), null);
});
