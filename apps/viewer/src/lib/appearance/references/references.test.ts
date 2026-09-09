/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { createElement } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { AuthorTab } from '@/components/viewer/ribbon/tabs/AuthorTab.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { fixtureModel } from '@/test/store-fixture.js';
import { appearanceAssets } from '../model-assets.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import { emptyPlacementState, displayedTranslation } from '@/lib/model-placement/state.js';
import { replayWorkspaceHistory } from '@/lib/model-placement/history.js';
import { MAX_REFERENCE_HISTORY, type RegisteredAppearanceReference } from './types.js';
import { parseReferences } from './persistence.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
const owner = { kind: 'source' as const, id: 'reference-fixture' };
function reset() {
  useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [], referenceRevision: 0,
    selectedAppearanceReferenceId: null, modelPlacement: emptyPlacementState(), models: new Map(), activeModelId: null,
    undoStacks: new Map(), redoStacks: new Map(), mutationViews: new Map(), storeEditors: new Map() });
  appearanceAssets.releaseOwner(owner);
}
afterEach(() => { cleanup(); reset(); });
async function reference(id = 'drawing'): Promise<RegisteredAppearanceReference> {
  const asset = await appearanceAssets.add(png, { owner });
  return { id, sourceId: 'original-document-page', assetId: asset.id,
    cornersIfcWorld: [[10000000.001, 0, 0], [10000002.001, 0, 0], [10000002.001, 3, 0], [10000000.001, 3, 0]],
    frameKey: placementFrameKey(useViewerStore.getState()), visible: true, locked: false, opacity: 0.75 };
}

test('registered image survives source removal and Undo/Redo, then releases at history prune (#4308)', async () => {
  const record = await reference(), state = useViewerStore.getState();
  state.addAppearanceReference(record);
  appearanceAssets.releaseOwner(owner);
  assert.ok(appearanceAssets.get(record.assetId));
  state.removeAppearanceReference(record.id);
  assert.ok(appearanceAssets.get(record.assetId), 'Undo owns the removed image');
  replayWorkspaceHistory(useViewerStore.getState(), 'undo');
  assert.equal(useViewerStore.getState().appearanceReferences.get(record.id)!.assetId, record.assetId);
  replayWorkspaceHistory(useViewerStore.getState(), 'redo');
  assert.equal(useViewerStore.getState().appearanceReferences.size, 0);
  useViewerStore.setState({ referenceUndo: [], referenceRedo: [] });
  assert.equal(appearanceAssets.get(record.assetId), undefined, 'last history lease released');
});

test('registration owns coordinates and locked records reject mutation or import replacement (#4308)', async () => {
  const record = await reference();
  useViewerStore.getState().addAppearanceReference(record);
  const owned = useViewerStore.getState().appearanceReferences.get(record.id)!;
  assert.notEqual(owned.cornersIfcWorld, record.cornersIfcWorld);
  assert.ok(Object.isFrozen(owned.cornersIfcWorld[0]));
  useViewerStore.getState().updateAppearanceReference(record.id, { locked: true });
  const before = useViewerStore.getState().appearanceReferences;
  assert.throws(() => useViewerStore.getState().updateAppearanceReference(record.id, { opacity: 0.2 }), /Unlock/);
  assert.throws(() => useViewerStore.getState().removeAppearanceReference(record.id), /Unlock/);
  const manifest = JSON.parse(useViewerStore.getState().exportAppearanceReferences()); manifest.references = [];
  assert.throws(() => useViewerStore.getState().importAppearanceReferences(JSON.stringify(manifest)), /Unlock/);
  assert.equal(useViewerStore.getState().appearanceReferences, before);
  useViewerStore.getState().updateAppearanceReference(record.id, { locked: false });
  useViewerStore.getState().updateAppearanceReference(record.id, { opacity: 0.2 });
});

test('registration restore is atomic, bounded and keeps missing assets recoverable by exact digest (#4308)', async () => {
  const record = await reference();
  useViewerStore.getState().addAppearanceReference(record);
  const text = useViewerStore.getState().exportAppearanceReferences();
  reset();
  useViewerStore.getState().importAppearanceReferences(text);
  assert.equal(appearanceAssets.get(record.assetId), undefined);
  assert.deepEqual(useViewerStore.getState().appearanceReferences.get(record.id)!.cornersIfcWorld, record.cornersIfcWorld);
  const before = useViewerStore.getState().appearanceReferences;
  assert.throws(() => useViewerStore.getState().importAppearanceReferences(text.replace('engineering-z-up', 'viewer-y-up')), /Unsupported/);
  assert.throws(() => parseReferences(text, 'different-frame'), /coordinate frame/);
  const duplicate = JSON.parse(text); duplicate.references.push(duplicate.references[0]);
  assert.throws(() => useViewerStore.getState().importAppearanceReferences(JSON.stringify(duplicate)), /Duplicate/);
  assert.equal(useViewerStore.getState().appearanceReferences, before);
  const altered = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  await assert.rejects(useViewerStore.getState().relinkAppearanceReference(record.id, new File([altered], 'other.png', { type: 'image/png' })), /does not match/);
  await useViewerStore.getState().relinkAppearanceReference(record.id, new File([png], 'original.png', { type: 'image/png' }));
  assert.ok(appearanceAssets.get(record.assetId));
  assert.equal(useViewerStore.getState().appearanceReferences, before, 'relink restores bytes, never repaints registration');
});

test('reference commands interleave with placement and branch invalidation in both directions (#4308)', async () => {
  const record = await reference();
  useViewerStore.setState({ models: new Map([['model', fixtureModel('model')]]), activeModelId: 'model' });
  useViewerStore.getState().addAppearanceReference(record);
  useViewerStore.getState().openReposition(['model']);
  useViewerStore.getState().previewModelTranslation([2, 0, 0]);
  useViewerStore.getState().applyModelTranslation();
  useViewerStore.getState().updateAppearanceReference(record.id, { opacity: 0.2 });
  replayWorkspaceHistory(useViewerStore.getState(), 'undo');
  assert.equal(useViewerStore.getState().appearanceReferences.get(record.id)!.opacity, 0.75);
  assert.equal(displayedTranslation(useViewerStore.getState().modelPlacement, 'model')[0], 2);
  replayWorkspaceHistory(useViewerStore.getState(), 'undo');
  assert.equal(displayedTranslation(useViewerStore.getState().modelPlacement, 'model')[0], 0);
  replayWorkspaceHistory(useViewerStore.getState(), 'redo');
  assert.equal(displayedTranslation(useViewerStore.getState().modelPlacement, 'model')[0], 2);
  useViewerStore.getState().openReposition(['model']);
  useViewerStore.getState().previewModelTranslation([1, 0, 0]);
  useViewerStore.getState().applyModelTranslation();
  assert.equal(useViewerStore.getState().referenceRedo.length, 0, 'new placement invalidates reference redo');
  replayWorkspaceHistory(useViewerStore.getState(), 'undo');
  useViewerStore.getState().updateAppearanceReference(record.id, { opacity: 0.5 });
  assert.equal(useViewerStore.getState().modelPlacement.redo.length, 0, 'new reference invalidates placement redo');
});

test('reference history is bounded and selection never uses IFC entity identities (#4308)', async () => {
  const record = await reference();
  useViewerStore.getState().addAppearanceReference(record);
  useViewerStore.setState({ selectedEntityId: 19 });
  useViewerStore.getState().selectAppearanceReference(record.id);
  for (let i = 0; i < MAX_REFERENCE_HISTORY + 2; i++) useViewerStore.getState().updateAppearanceReference(record.id, { opacity: i % 2 });
  assert.equal(useViewerStore.getState().referenceUndo.length, MAX_REFERENCE_HISTORY);
  assert.equal(useViewerStore.getState().selectedEntityId, 19);
  useViewerStore.getState().removeAppearanceReference(record.id);
  assert.equal(useViewerStore.getState().selectedAppearanceReferenceId, null);
});


test('IFC edits and reference edits share Undo order and invalidate one another’s redo (#4308)', async () => {
  const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Reference history'),'2;1');FILE_NAME('test.ifc','',(),(),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCCOLOURRGB($,1.,0.,0.);ENDSEC;END-ISO-10303-21;`);
  const data = await new IfcParser().parseColumnar(bytes.buffer);
  const view = new MutablePropertyView(data.properties, 'model');
  const editor = new StoreEditor(data, view);
  useViewerStore.setState({ models: new Map([['model', { ...fixtureModel('model'), ifcDataStore: data }]]),
    activeModelId: 'model', storeEditors: new Map([['model', editor]]) });
  useViewerStore.getState().registerMutationView('model', view);
  const record = await reference();
  useViewerStore.getState().addAppearanceReference(record);
  useViewerStore.getState().setPositionalAttribute('model', 1, 1, 0.25);
  useViewerStore.getState().updateAppearanceReference(record.id, { opacity: 0.2 });
  replayWorkspaceHistory(useViewerStore.getState(), 'undo');
  assert.equal(view.getPositionalMutationsForEntity(1)?.get(1), 0.25);
  assert.equal(useViewerStore.getState().appearanceReferences.get(record.id)!.opacity, 0.75);
  useViewerStore.getState().setPositionalAttribute('model', 1, 1, 0.5);
  assert.equal(useViewerStore.getState().referenceRedo.length, 0);
  replayWorkspaceHistory(useViewerStore.getState(), 'undo');
  assert.equal(view.getPositionalMutationsForEntity(1)?.get(1), 0.25);
  useViewerStore.getState().updateAppearanceReference(record.id, { opacity: 0.4 });
  assert.equal(useViewerStore.getState().redoStacks.size, 0);
});


test('the actual Author toolbar enables reference-only Undo/Redo without an active IFC model (#4308)', async () => {
  const record = await reference();
  useViewerStore.getState().addAppearanceReference(record);
  const ui = render(createElement(AuthorTab));
  function button(label: string): HTMLButtonElement {
    const result = [...ui.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label);
    assert.ok(result, label); return result;
  }
  assert.equal(button('Undo').disabled, false);
  click(button('Undo'));
  assert.equal(useViewerStore.getState().appearanceReferences.size, 0);
  assert.equal(button('Redo').disabled, false);
  click(button('Redo'));
  assert.equal(useViewerStore.getState().appearanceReferences.get(record.id)!.assetId, record.assetId);
});
