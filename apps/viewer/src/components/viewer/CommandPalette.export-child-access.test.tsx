/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { useViewerStore } from '@/store';
import { getLocale, setLocale } from '@/i18n';
import { createLocaleActivator } from '@/i18n/locale-activation';
import { Toaster } from '@/components/ui/toast';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { cleanup, click, type as enterText, waitFor } from '@/test/render';
import { mountDestinations, launchDestination, namedButton } from '@/test/palette-destinations';
import { useFileCommands } from './toolbar/useFileCommands';

// #8947: missing palette -> canonical export consumer joins only. Real parsed
// authored IFC + native CSV, no product handler or successful result mocks.
const initial = useViewerStore.getState();
const locale = getLocale();
const objectURL = URL.createObjectURL;
const revokeURL = URL.revokeObjectURL;
const anchorClick = HTMLAnchorElement.prototype.click;
const hosts: ReturnType<typeof mountDestinations>[] = [];
let blobs: Blob[];
let saves: Array<{ filename: string; outcomes: string[] }>;
beforeEach(() => {
  setLocale('en'); localStorage.clear();
  useViewerStore.setState({ ...fixtureModels(), ifcDataStore: null, geometryResult: null,
    collabRoomId: null, collabRole: null, loading: false, mutationViews: new Map(), georefMutations: new Map() });
  useActivityJournal.setState({ jobs: [] });
  blobs = []; saves = [];
  URL.createObjectURL = value => {
    assert.ok(value instanceof Blob); blobs.push(value); return `blob:palette-export-${blobs.length}`;
  };
  URL.revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = function () {
    saves.push({ filename: this.download, outcomes: useActivityJournal.getState().jobs.map(job => job.outcome) });
  };
});
// Each file runs in an isolated node:test process. Never restore publication
// globals while a native operation from this fixture can still use them.
async function drainExports() {
  try {
    await waitFor(() => useActivityJournal.getState().jobs.every(job => job.outcome !== 'running'),
      'owned native exports settle before fixture teardown', 30_000);
  } catch (error) {
    console.error('Retiring isolated CSV test process with an unsettled owned export:', error);
    process.exit(1);
  }
}
afterEach(async () => {
  await drainExports();
  for (const button of document.querySelectorAll('[data-toast-seq] button')) click(button);
  cleanup();
  for (const host of hosts.splice(0)) await host.dispose();
  mock.restoreAll(); useViewerStore.setState(initial, true);
  useActivityJournal.setState({ jobs: [] }); setLocale(locale); localStorage.clear();
  URL.createObjectURL = objectURL; URL.revokeObjectURL = revokeURL; HTMLAnchorElement.prototype.click = anchorClick;
});
async function seed(federated = false) {
  const bytes = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
  const wall = store.entityIndex.byType.get('IFCWALL')?.[0]; assert.ok(wall);
  const view = new MutablePropertyView(store.properties ?? null, 'target');
  configureMutationView(view, store);
  view.setAttribute(wall, 'Name', 'Palette reviewed target wall', store.entities.getName(wall) ?? '');
  const target = { ...fixtureModel('target'), name: 'Target.ifc', ifcDataStore: store };
  const peer = { ...fixtureModel('peer'), name: 'Peer.ifc', ifcDataStore: store };
  useViewerStore.setState({ ...fixtureModels(target, ...(federated ? [peer] : [])),
    ifcDataStore: store, mutationViews: new Map([['target', view]]) });
  return { target, peer, store, wall };
}
function mount() { hosts.push(mountDestinations(null)); }
function exportDialog() {
  const dialog = document.querySelector<HTMLElement>('[data-export-dialog-shell]'); assert.ok(dialog); return dialog;
}

for (const table of ['entities', 'properties', 'quantities', 'spatial'] as const) {
  test(`#8947 palette CSV ${table} reaches actual Rust writer and publishes the invocation target`, async t => {
    if (!ensureWasm(t)) return;
    const { peer, store, wall } = await seed(true); mount();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const init = GeometryProcessor.prototype.init;
    // Delay only the REAL processor after initialization; never replace its result.
    mock.method(GeometryProcessor.prototype, 'init', async function (this: GeometryProcessor) {
      await init.call(this); entered = true;
      await gate;
    });
    try {
      await launchDestination(`export:csv-${table}`, 'CSV');
      await waitFor(() => entered, 'actual initialized Rust writer');
      assert.equal(document.querySelector('input[role="combobox"]'), null);
      assert.equal(useActivityJournal.getState().jobs.length, 1);
      assert.equal(useActivityJournal.getState().jobs[0].outcome, 'running');
      assert.match(useActivityJournal.getState().jobs[0].subject ?? '', /Target.ifc.*1 other loaded model/);
      assert.equal(blobs.length, 0);
      // Changing the live active model cannot relabel or replace the captured invocation.
      act(() => useViewerStore.setState({ activeModelId: peer.id, ifcDataStore: peer.ifcDataStore }));
    } finally {
      await act(async () => { release(); });
      await drainExports();
    }
    assert.equal(useActivityJournal.getState().jobs[0].outcome, 'completed');
    assert.equal(blobs.length, 1); assert.equal(blobs[0].type, 'text/csv');
    assert.deepEqual(saves, [{ filename: `Target_${table === 'spatial' ? 'spatial-hierarchy' : table}.csv`, outcomes: ['running'] }]);
    const csv = await blobs[0].text();
    assert.ok(csv.trim().split('\n').length > 1);
    if (table === 'entities' || table === 'spatial') {
      assert.ok(csv.includes('Palette reviewed target wall'));
      assert.ok(csv.includes(store.entities.getGlobalId(wall) ?? 'missing-guid'));
    } else {
      const globalId = store.entities.getGlobalId(wall); assert.ok(globalId);
      assert.ok(csv.split('\n').some(row => row.startsWith(
        `${wall},${globalId},Palette reviewed target wall,IfcWall,`,
      )), 'properties/quantities must contain the edited invocation target on the same row');
      assert.match(csv, table === 'properties' ? /psetName,propName,value/ : /qsetName,quantityName,value/);
    }
  });
}

test('#8947 CSV initialization wait failure drains the owned operation before restoring publication', async t => {
  if (!ensureWasm(t)) return;
  await seed(); mount();
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let initialized = false;
  const init = GeometryProcessor.prototype.init;
  mock.method(GeometryProcessor.prototype, 'init', async function (this: GeometryProcessor) {
    await gate;
    await init.call(this); initialized = true;
  });
  try {
    await launchDestination('export:csv-entities', 'CSV');
    assert.equal(useActivityJournal.getState().jobs[0]?.outcome, 'running');
    await assert.rejects(waitFor(() => initialized, 'deliberately blocked initialization', 1),
      /deliberately blocked initialization/);
    assert.equal(blobs.length, 0);
  } finally {
    // Exercise the failure path while initialization has NOT completed, exactly
    // where the former entered-only cleanup skipped the running export.
    release();
    await drainExports();
  }
  assert.equal(initialized, true);
  assert.equal(useActivityJournal.getState().jobs[0].outcome, 'completed');
  assert.equal(blobs.length, 1); assert.equal(saves.length, 1);
});

test('#8947 palette CSV native publication refusal records Failed without a download', async t => {
  if (!ensureWasm(t)) return;
  await seed(); mount();
  URL.createObjectURL = () => { throw new Error('Browser refused palette CSV publication'); };
  await launchDestination('export:csv-entities', 'CSV');
  await waitFor(() => useActivityJournal.getState().jobs.some(job => job.outcome === 'failed'), 'real writer reaches refusing browser sink');
  assert.match(useActivityJournal.getState().jobs[0].detail ?? '', /Browser refused palette CSV publication/);
  assert.equal(saves.length, 0);
});

for (const [language, remedy] of [
  ['en', 'Open the 3D view and wait for it to finish loading, then try again.'],
  ['de', 'Öffnen Sie die 3D-Ansicht und warten Sie, bis sie vollständig geladen ist. Versuchen Sie es dann erneut.'],
  ['ru', 'Откройте 3D-вид и дождитесь его полной загрузки, затем повторите попытку.'],
] as const) test(`#8947 palette screenshot gives a visible missing-viewport remedy in ${language}`, async () => {
  await seed();
  const activator = createLocaleActivator({
    de: () => import('@/i18n/locales/de/shared-commands').then(module => module.sharedCommandsDe),
    ru: () => import('@/i18n/locales/ru').then(module => module.default),
  });
  await activator.activate([language]);
  assert.equal(getLocale(), language, 'real catalogue activated before the screenshot action');
  hosts.push(mountDestinations(<Toaster />));
  assert.equal(getGlobalRenderer(), null, 'this mounted DOM has no GPU viewport');
  await launchDestination('export:screenshot', 'screenshot');
  await waitFor(() => document.body.textContent?.includes(remedy) === true, 'actual localized refusal and next step');
  assert.equal(saves.length, 0); assert.equal(blobs.length, 0);
  // Successful capture is exercised separately with the real browser GPU renderer.
});

test('#8947 palette GLB child edits visible-only review for the selected parsed model and cancels', async () => {
  await seed(true); mount();
  await launchDestination('export:glb', 'GLB');
  const dialog = exportDialog();
  assert.match(dialog.textContent ?? '', /Target.ifc/);
  // This parsed-only fixture honestly has no loaded meshes: export is unavailable.
  assert.equal(namedButton('Export', dialog).disabled, true);
  const switches = dialog.querySelectorAll<HTMLElement>('[role="switch"]');
  assert.equal(switches.length, 3);
  assert.equal(switches[0].getAttribute('aria-checked'), 'false'); click(switches[0]);
  assert.equal(switches[0].getAttribute('aria-checked'), 'true');
  assert.match(dialog.textContent ?? '', /Target_visible.glb/);
  click(namedButton('Cancel', dialog));
  await waitFor(() => !document.querySelector('[data-export-dialog-shell]'), 'GLB review cancels');
  assert.equal(saves.length, 0); assert.equal(useActivityJournal.getState().jobs.length, 0);
});

test('#8947 palette ion child configures local review then closes and clears token without upload', async () => {
  await seed(); mount();
  let network = 0;
  mock.method(globalThis, 'fetch', async () => { network++; throw new Error('Remote operations forbidden in review test'); });
  await launchDestination('export:ion', 'cesium ion');
  const token = document.querySelector<HTMLInputElement>('#ion-token'); assert.ok(token);
  assert.equal(namedButton('Upload').disabled, true);
  assert.match(document.querySelector('#ion-model')?.textContent ?? '', /Target.ifc/);
  assert.ok(document.querySelector('a[href="https://ion.cesium.com/tokens"]'), 'real missing-token remedy');
  enterText(token, 'local-review-only-not-a-credential');
  assert.equal(namedButton('Upload').disabled, false, 'configuration reaches launch review, never invokes it');
  click(namedButton('Close')); await waitFor(() => !document.querySelector('#ion-token'), 'ion closes');
  await launchDestination('export:ion', 'cesium ion');
  assert.equal(document.querySelector<HTMLInputElement>('#ion-token')?.value, '');
  assert.equal(namedButton('Upload').disabled, true); click(namedButton('Close'));
  assert.equal(network, 0); assert.equal(saves.length, 0);
});

function FileHost() { return <>{useFileCommands().fileInputs}</>; }
test('#8947 palette Share child reviews parsed federation scope and role then cancels before consent', async () => {
  await seed(true); localStorage.setItem('ifc-lite:collab:enabled', 'true');
  let network = 0;
  mock.method(globalThis, 'fetch', async () => { network++; throw new Error('Remote operations forbidden in review test'); });
  hosts.push(mountDestinations(<FileHost />));
  await launchDestination('file:share', 'share');
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(dialog);
  assert.match(dialog.textContent ?? '', /Target.ifc|2 models/);
  const active = [...dialog.querySelectorAll<HTMLElement>('[role="radio"]')].find(row => /Active model only/i.test(row.textContent ?? ''));
  assert.ok(active); click(active); assert.equal(active.getAttribute('aria-checked'), 'true');
  const editor = [...dialog.querySelectorAll<HTMLElement>('[role="radio"]')].find(row => /^Edit$/.test(row.textContent?.trim() ?? ''));
  assert.ok(editor); click(editor); assert.equal(editor.getAttribute('aria-checked'), 'true');
  assert.equal(namedButton('Create link', dialog).disabled, false);
  assert.equal(namedButton('Copy', dialog).disabled, true, 'review has no fabricated room link');
  click(namedButton('Close', dialog));
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'Share review cancels');
  assert.equal(useViewerStore.getState().collabRoomId, null); assert.equal(network, 0);
});
