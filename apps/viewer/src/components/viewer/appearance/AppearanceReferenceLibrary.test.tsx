/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, type, press, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { emptyPlacementState } from '@/lib/model-placement/state.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import type { RegisteredAppearanceReference } from '@/lib/appearance/references/types.js';
import { AppearanceReferenceLibrary } from './AppearanceReferenceLibrary.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
const owner = { kind: 'source' as const, id: 'reference-library-fixture' };
function reset() {
  useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [], referenceRevision: 0,
    selectedAppearanceReferenceId: null, appearanceSources: [], modelPlacement: emptyPlacementState(),
    models: new Map(), activeModelId: null, undoStacks: new Map(), redoStacks: new Map(), selectedEntityId: null });
  appearanceAssets.releaseOwner(owner);
}
afterEach(() => { cleanup(); reset(); mock.restoreAll(); });
async function fixture() {
  const asset = await appearanceAssets.add(png, { owner });
  const record: RegisteredAppearanceReference = { id: 'registered-drawing', sourceId: 'page-source', assetId: asset.id,
    cornersIfcWorld: [[0, 3, 0], [2, 3, 0], [2, 0, 0], [0, 0, 0]],
    frameKey: placementFrameKey(useViewerStore.getState()), visible: true, locked: false, opacity: 0.75 };
  useViewerStore.getState().addAppearanceReference(record);
  return record;
}
function button(ui: HTMLElement, label: string): HTMLButtonElement {
  const result = [...ui.querySelectorAll<HTMLButtonElement>('button')].find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
  assert.ok(result, label); return result;
}
async function choose(ui: HTMLElement, label: string, file: File) {
  const input = ui.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); assert.ok(input);
  const transfer = new window.DataTransfer(); transfer.items.add(file);
  Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}

test('registered drawing controls select separately, respect lock, and remove through real buttons (#4308)', async () => {
  const record = await fixture(); useViewerStore.setState({ selectedEntityId: 19 });
  const edits: string[] = [];
  const ui = render(<AppearanceReferenceLibrary onEdit={id => edits.push(id)} />);
  click(button(ui, 'Select Drawing 1'));
  assert.equal(useViewerStore.getState().selectedAppearanceReferenceId, record.id);
  assert.equal(useViewerStore.getState().selectedEntityId, 19);
  click(button(ui, 'Hide Drawing 1'));
  assert.equal(useViewerStore.getState().appearanceReferences.get(record.id)!.visible, false);
  click(button(ui, 'Show Drawing 1'));
  click(button(ui, 'Edit Drawing 1'));
  assert.deepEqual(edits, [record.id]);
  click(button(ui, 'Lock Drawing 1'));
  assert.equal(button(ui, 'Hide Drawing 1').disabled, true);
  assert.equal(button(ui, 'Remove Drawing 1').disabled, true);
  assert.equal(button(ui, 'Edit Drawing 1').disabled, true);
  assert.equal(ui.querySelector<HTMLInputElement>('input[type="number"]')!.disabled, true);
  click(button(ui, 'Unlock Drawing 1'));
  click(button(ui, 'Remove Drawing 1'));
  assert.equal(useViewerStore.getState().appearanceReferences.size, 0);
  assert.match(ui.textContent!, /Registered drawings will appear here/);
  assert.ok(appearanceAssets.get(record.assetId), 'Undo retains removed drawing bytes');
});

test('opacity commits one validated edit on Enter and shows invalid input inline (#4308)', async () => {
  const record = await fixture(); const ui = render(<AppearanceReferenceLibrary />);
  const input = ui.querySelector<HTMLInputElement>('input[aria-label="Opacity for Drawing 1"]')!;
  type(input, '2'); type(input, '25');
  assert.equal(useViewerStore.getState().referenceUndo.length, 1, 'typing does not fill Undo');
  press(input, 'Enter');
  assert.equal(useViewerStore.getState().appearanceReferences.get(record.id)!.opacity, 0.25);
  assert.equal(useViewerStore.getState().referenceUndo.length, 2);
  type(input, '150'); press(input, 'Enter');
  assert.match(ui.querySelector('[role="alert"]')!.textContent!, /between 0 and 100/);
  assert.equal(useViewerStore.getState().appearanceReferences.get(record.id)!.opacity, 0.25);
});

test('exported registration restores from file and missing images relink only exact bytes (#4308)', async () => {
  const record = await fixture(); let downloaded: Blob | undefined;
  mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => { assert.ok(value instanceof Blob); downloaded = value; return 'blob:registration-test'; });
  let ui = render(<AppearanceReferenceLibrary />);
  click(button(ui, 'Export drawing registration'));
  assert.ok(downloaded); const text = await downloaded.text();
  const manifest = JSON.parse(text);
  assert.equal(manifest.references[0].assetId, record.assetId);
  assert.equal('bytes' in manifest.references[0], false);
  cleanup(); reset();
  ui = render(<AppearanceReferenceLibrary />);
  click(button(ui, 'Import drawing registration'));
  await choose(ui, 'Drawing registration file', new File([text], 'drawing-registration.json', { type: 'application/json' }));
  assert.equal(useViewerStore.getState().appearanceReferences.size, 1);
  assert.match(ui.textContent!, /Original image needed/);
  click(button(ui, 'Relink image for Drawing 1'));
  // A second complete PNG with a different digest, not a mocked inventory result.
  const other = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  await choose(ui, 'Original drawing image', new File([other], 'different.png', { type: 'image/png' }));
  assert.match(ui.querySelector('[role="alert"]')!.textContent!, /does not match/);
  assert.equal(appearanceAssets.get(record.assetId), undefined);
  click(button(ui, 'Relink image for Drawing 1'));
  await choose(ui, 'Original drawing image', new File([png], 'original.png', { type: 'image/png' }));
  assert.ok(appearanceAssets.get(record.assetId));
  assert.doesNotMatch(ui.textContent!, /Original image needed/);
});

test('invalid import and canceled pending file read never replace existing registrations (#4308)', async () => {
  await fixture(); const before = useViewerStore.getState().appearanceReferences;
  const ui = render(<AppearanceReferenceLibrary />);
  await choose(ui, 'Drawing registration file', new File(['{"version":99}'], 'invalid.json', { type: 'application/json' }));
  assert.match(ui.querySelector('[role="alert"]')!.textContent!, /Unsupported/);
  assert.equal(useViewerStore.getState().appearanceReferences, before);
  const text = useViewerStore.getState().exportAppearanceReferences();
  const file = new File([text], 'slow.json', { type: 'application/json' });
  let finish!: (text: string) => void;
  mock.method(file, 'text', () => new Promise<string>(resolve => { finish = resolve; }));
  await choose(ui, 'Drawing registration file', file);
  assert.equal(button(ui, 'Cancel file operation').disabled, false);
  click(button(ui, 'Cancel file operation'));
  await act(async () => { finish(text); await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(useViewerStore.getState().appearanceReferences, before);
  assert.equal(useViewerStore.getState().referenceUndo.length, 1);
});
