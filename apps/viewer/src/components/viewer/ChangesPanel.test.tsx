/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { IfcParser } from '@ifc-lite/parser';
import { cleanup, click, render } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { ChangesPanel } from './ChangesPanel';
import { revertChangeOperation } from '@/lib/changes/revert-change-operation';
import { changeOperations } from '@/lib/changes/change-operations';
import { inverseMutationTargets } from '@/store/slices/mutation-inverse-registry';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); });

function button(ui: HTMLElement, label: string): HTMLButtonElement {
  const match = [...ui.querySelectorAll('button')].find(candidate => candidate.getAttribute('aria-label')?.includes(label)
    || candidate.textContent?.trim() === label);
  assert.ok(match, `Missing button: ${label}`);
  return match;
}

async function withCapturedDownloads(run: (downloads: Blob[]) => Promise<void>): Promise<void> {
  const downloads: Blob[] = [];
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  const anchorClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = ((blob: Blob) => { downloads.push(blob); return 'blob:changes-test'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = () => {};
  try { await run(downloads); }
  finally {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    HTMLAnchorElement.prototype.click = anchorClick;
  }
}

for (const count of [1, 2]) test(`#5902 Changes drawer lists property and Bulk rows, jumps, and reverts at ${count} model(s)`, async () => {
  const ids = count === 1 ? ['A'] : ['A', 'B'];
  const models = new Map(ids.map((id, index) => [id, {
    ...fixtureModel(id, { idOffset: index * 1_000, entities: [
      { expressId: 101, type: 'IfcWall', name: 'Source wall' },
      { expressId: 102, type: 'IfcWall', name: 'Bulk wall' },
    ] }), maxExpressId: 102,
  }] as const));
  const views = new Map(ids.map(id => [id, new MutablePropertyView(null, id)] as const));
  let frames = 0;
  useViewerStore.setState({ models, activeModelId: 'A', mutationViews: views, undoStacks: new Map(),
    redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    editEnabled: true, collabRoomId: null, cameraCallbacks: { frameSelection: () => { frames++; } } });
  const state = useViewerStore.getState();
  state.setProperty('A', 101, 'Pset_Test', 'Status', 'before', PropertyValueType.Label);
  const bulkA = views.get('A')!.setProperty(102, 'Pset_Bulk', 'Code', 'bulk', PropertyValueType.Label);
  const tag = state.recordMutationBatch('A', [bulkA]);
  if (count === 2) {
    const bulkB = views.get('B')!.setProperty(102, 'Pset_Bulk', 'Code', 'bulk', PropertyValueType.Label);
    state.recordMutationBatch('B', [bulkB], tag ?? undefined);
  }
  const ui = render(<ChangesPanel />);
  assert.match(ui.textContent ?? '', /2 edits/);
  assert.equal(ui.querySelectorAll('ol > li').length, 2);
  assert.match(ui.querySelector('ol > li')?.textContent ?? '', count === 2 ? /2 edits/ : /1 edit/);

  click(button(ui, 'Jump to IfcWall #101 in A'));
  assert.equal(useViewerStore.getState().selectedEntityId, 101);
  assert.deepEqual(useViewerStore.getState().selectedEntity, { modelId: 'A', expressId: 101 });
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(frames, 1);

  const older = ui.querySelectorAll('ol > li')[1];
  click(button(older as HTMLElement, 'Revert'));
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_Test', 'Status'), null);
  assert.equal(views.get('A')!.getPropertyValue(102, 'Pset_Bulk', 'Code'), 'bulk');
  assert.equal(ui.querySelectorAll('ol > li').length, 1);
  assert.match(ui.textContent ?? '', /1 edit/);
  act(() => useViewerStore.getState().undo('A'));
  assert.equal(ui.querySelectorAll('ol > li').length, 2, 'Undo restores the older row');
});

test('#5902 authored Bonsai IFC wall is selected and its older property edit is restored', async () => {
  const source = await readFile(new URL('../../../public/samples/hello-wall.ifc', import.meta.url));
  const data = await new IfcParser().parseColumnar(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  const wall = [...data.entityIndex.byId].find(([, ref]) => ref.type === 'IFCWALL')?.[0];
  assert.ok(wall, 'the authored fixture contains an IfcWall');
  const view = new MutablePropertyView(data.properties, 'Bonsai');
  const model = { ...fixtureModel('Bonsai'), ifcDataStore: data, schemaVersion: 'IFC4' as const,
    maxExpressId: Math.max(...data.entityIndex.byId.keys()) };
  let framed = 0;
  useViewerStore.setState({ models: new Map([['Bonsai', model]]), activeModelId: 'Bonsai',
    mutationViews: new Map([['Bonsai', view]]), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    editEnabled: true, collabRoomId: null, cameraCallbacks: { frameSelection: () => { framed++; } } });
  const first = useViewerStore.getState().setProperty('Bonsai', wall, 'Pset_Changes', 'Status', 'draft', PropertyValueType.Label);
  assert.ok(first);
  const bulk = view.setProperty(wall, 'Pset_Changes', 'ReviewCode', 'B1', PropertyValueType.Label);
  useViewerStore.getState().recordMutationBatch('Bonsai', [bulk]);
  const ui = render(<ChangesPanel />);
  assert.equal(ui.querySelectorAll('ol > li').length, 2);
  click(button(ui, `Jump to IfcWall #${wall} in Bonsai`));
  assert.deepEqual(useViewerStore.getState().selectedEntity, { modelId: 'Bonsai', expressId: wall });
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(framed, 1);
  click(button(ui.querySelectorAll('ol > li')[1] as HTMLElement, 'Revert'));
  assert.equal(view.getPropertyValue(wall, 'Pset_Changes', 'Status'), null);
  assert.equal(view.getPropertyValue(wall, 'Pset_Changes', 'ReviewCode'), 'B1');
  assert.equal(ui.querySelectorAll('ol > li').length, 1);

  // The downloaded delta must agree with the overlay after Revert. The view's
  // raw mutation history still contains Status because replay skips history.
  assert.equal(view.getMutations().length, 2);
  await withCapturedDownloads(async downloads => {
    click(button(ui, 'Changes only (JSON delta)'));
    const exportButton = button(document.body, 'Export');
    assert.equal(exportButton.disabled, false, document.body.textContent ?? '');
    click(exportButton);
    const firstDownload = downloads[0];
    assert.ok(firstDownload, document.body.textContent ?? '');
    const afterInverse = JSON.parse(await firstDownload.text()) as { mutations: Array<{ id: string; propName?: string }> };
    assert.deepEqual(afterInverse.mutations.map(mutation => mutation.propName), ['ReviewCode']);
    await act(async () => { await Promise.resolve(); });

    const state = useViewerStore.getState();
    const remaining = changeOperations(state.undoStacks, state.mutationBatchTags, inverseMutationTargets(useViewerStore));
    assert.deepEqual(revertChangeOperation(useViewerStore, remaining[0]), { ok: true, mode: 'inverse' });
    assert.equal(exportButton.disabled, false);
    click(exportButton);
    const secondDownload = downloads[1];
    assert.ok(secondDownload);
    const afterTopUndo = JSON.parse(await secondDownload.text()) as { mutations: unknown[] };
    assert.deepEqual(afterTopUndo.mutations, [], 'successive Reverts cannot leak append-only records into the delta');
  });
});

test('#5902 the drawer names an IFC5 delta as an IFCX overlay', () => {
  const model = { ...fixtureModel('IFC5'), schemaVersion: 'IFC5' as const, maxExpressId: 102 };
  const view = new MutablePropertyView(null, 'IFC5');
  useViewerStore.setState({ models: new Map([['IFC5', model]]), activeModelId: 'IFC5',
    mutationViews: new Map([['IFC5', view]]), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0, editEnabled: true });
  useViewerStore.getState().setProperty('IFC5', 101, 'Pset_Test', 'Status', 'draft', PropertyValueType.Label);
  assert.match(render(<ChangesPanel />).textContent ?? '', /Changes only \(IFCX overlay\)/);
});

test('#5902 georeference row has no fake Jump and downloads its model-level mutation', async () => {
  const model = { ...fixtureModel('A'), schemaVersion: 'IFC4' as const, maxExpressId: 102 };
  useViewerStore.setState({ models: new Map([['A', model]]), activeModelId: 'A',
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(),
    georefMutations: new Map(), editEnabled: true });
  useViewerStore.getState().setGeorefFields('A', 'mapConversion', [{ field: 'Eastings', value: 42 }]);
  const ui = render(<ChangesPanel />);
  assert.match(ui.textContent ?? '', /Georeference/);
  assert.equal(ui.querySelectorAll('button[aria-label^="Jump to"]').length, 0);
  await withCapturedDownloads(async downloads => {
    click(button(ui, 'Changes only (JSON delta)'));
    click(button(document.body, 'Export'));
    const download = downloads[0];
    assert.ok(download, 'a georeference-only row must not export an empty delta');
    const payload = JSON.parse(await download.text()) as { mutations: Array<{ attributeName?: string; newValue?: unknown }> };
    assert.deepEqual(payload.mutations.map(mutation => mutation.attributeName), ['georef.mapConversion.Eastings']);
    assert.deepEqual(payload.mutations.map(mutation => mutation.newValue), [42]);
  });
});
