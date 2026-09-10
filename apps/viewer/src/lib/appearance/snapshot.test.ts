/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import type { AppearancePlanner } from './planner-worker-client.js';
import { prepareAppearanceSnapshot } from './snapshot.js';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

async function fixture() {
  const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Effective scope'),'2;1');
FILE_NAME('scope.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#10=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,.NOTDEFINED.);
ENDSEC;END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties, 'scope');
  const editor = new StoreEditor(store, view);
  useViewerStore.setState({ models: new Map([['scope', { ...fixtureModel('scope'),
    ifcDataStore: store, schemaVersion: 'IFC4', loadedAt: 1 }]]),
    mutationViews: new Map([['scope', view]]), mutationVersion: 0 });
  return { store, view, editor };
}

function catalogBoundary(beforeReply?: () => Promise<void>): AppearancePlanner {
  return {
    async pdfFillPlan() { throw new Error('Catalog tests must not create PDF geometry'); },
    async meshTransfer() { throw new Error('Catalog tests must not transfer appearance'); },
    async registerScan() { throw new Error('Catalog tests must not solve registration'); },
    async catalog(_bytes, request) {
      await beforeReply?.();
      return { sourceRevision: request.sourceRevision, products: [], types: [], missingProductIds: [] };
    },
    async plan() { throw new Error('This test must not create geometry'); },
    async capturedMeshPlan() { throw new Error('This catalog test must not create captured objects'); },
    async annotationPlan() { throw new Error('This catalog test must not create annotations'); },
    async pagePlan() { throw new Error('This catalog test must not plan a page'); },
    cancel() {}, dispose() {},
  };
}

it('rebuilds effective scope bytes after an SDK retype without a viewer revision change (#4243)', async () => {
  const { editor, view } = await fixture();
  const planner = catalogBoundary(), signal = new AbortController().signal;
  const first = await prepareAppearanceSnapshot(null, 'scope', [10], planner, signal);
  const before = await new IfcParser().parseColumnar(new Uint8Array(first.bytes).buffer, { disableWorkerScan: true });
  assert.equal(before.entities.getTypeName(10), 'IfcWall');
  editor.setEntityType(10, 'IfcSlab');
  assert.equal(useViewerStore.getState().mutationVersion, 0);
  assert.throws(() => first.validate(), /overlay changed/);
  const next = await prepareAppearanceSnapshot(first, 'scope', [10], planner, signal);
  const after = await new IfcParser().parseColumnar(new Uint8Array(next.bytes).buffer, { disableWorkerScan: true });
  assert.equal(after.entities.getTypeName(10), 'IfcSlab');
  next.validate();
  assert.equal(view.getEntityTypeMutation(10)?.newType.toUpperCase(), 'IFCSLAB');
});

it('rejects a catalog response after an intervening direct SDK edit (#4243)', async () => {
  const { editor } = await fixture();
  let reply!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { reply = resolve; });
  const pending = prepareAppearanceSnapshot(null, 'scope', [10], catalogBoundary(async () => {
    entered(); await delayed;
  }), new AbortController().signal);
  await ready;
  // Direct editor calls bypass the viewer's reactive revision, like SDK writes.
  editor.setAttribute(10, 'Name', 'Newer SDK edit');
  reply();
  await assert.rejects(pending, /overlay changed/);
  assert.equal(useViewerStore.getState().mutationVersion, 0);
});

it('cancels scope preparation without publishing IFC edits or moving the allocator (#4243)', async () => {
  const { view } = await fixture();
  const nextId = view.peekNextExpressId();
  const abort = new AbortController();
  await assert.rejects(prepareAppearanceSnapshot(null, 'scope', [10], catalogBoundary(async () => {
    abort.abort();
  }), abort.signal), { name: 'AbortError' });
  assert.equal(view.peekNextExpressId(), nextId);
  assert.equal(view.getMutations().length, 0);
  assert.equal(view.getNewEntities().length, 0);
});
