/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { act } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { render, click, type, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { calibrateAppearancePlane, type PlaneCalibrationRequest } from '@/lib/appearance/plane-calibration.js';
import { DEFAULT_APPEARANCE_SETTINGS } from '@/lib/appearance/settings.js';
import { emptyPlacementState } from '@/lib/model-placement/state.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import { referenceEditSettings } from '@/lib/appearance/references/edit.js';
import { AppearancePanel } from './AppearancePanel.js';
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
const owner = { kind: 'source' as const, id: 'edit-fixture' };
const recipe: PlaneCalibrationRequest = { rasterToSource: [72, 0, 0, -72, 10, 92], rasterSize: [1, 1],
  sourcePoints: [[10, 92], [82, 92]], distanceMetres: 2, worldAnchor: [100, 200, 3],
  worldDirection: [0, 1, 0], planeNormal: [0, 0, 1] };
function button(ui: HTMLElement, label: string) {
  const element = [...ui.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  assert.ok(element, label); return element;
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); }); }
afterEach(() => {
  cleanup(); setGlobalRendererRef({ current: null }); mock.restoreAll();
  for (const source of useViewerStore.getState().appearanceSources) useViewerStore.getState().removeAppearanceSource(source.id);
  useViewerStore.getState().resetViewerState(); appearanceAssets.releaseOwner(owner);
});
const artifact = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
async function nativeAvailable(t: TestContext): Promise<boolean> {
  try { await access(artifact); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Run pnpm build:wasm for native reference calibration'); return false;
  }
}
async function fixture() {
  const { default: init } = await import('@ifc-lite/wasm'); await init({ module_or_path: await readFile(artifact) });
  useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [], referenceRevision: 0,
    appearanceSources: [], models: new Map(), activeModelId: null, collabRoomId: null,
    modelPlacement: emptyPlacementState(), geometryResult: null,
    appearanceDraft: { intent: 'reference', modelId: null, sourceId: null, scope: { kind: 'model' }, settings: DEFAULT_APPEARANCE_SETTINGS, previewEnabled: false } });
  const asset = await appearanceAssets.add(png, { owner });
  const calibrated = await calibrateAppearancePlane(recipe);
  assert.equal(calibrated.rasterCorners.length, 4);
  const [a,b,c,d] = calibrated.rasterCorners;
  useViewerStore.getState().addAppearanceReference({ id: 'drawing', sourceId: 'removed-pdf', assetId: asset.id,
    cornersIfcWorld: [a,b,c,d], frameKey: placementFrameKey(useViewerStore.getState()),
    visible: true, locked: false, opacity: 0.6, calibration: recipe });
  // GPU transport alone is stubbed; metric calibration, PNG inventory, source
  // restoration, mounted controls and workspace commands all execute normally.
  const renderer = new Renderer(document.createElement('canvas'));
  mock.method(renderer.getReferenceImages(), 'set', async () => {});
  mock.method(renderer.getReferenceImages(), 'remove', () => {});
  mock.method(appearanceAssets, 'decode', async () => ({ width: 1, height: 1, close() {} }));
  setGlobalRendererRef({ current: renderer });
  const original = useViewerStore.getState().appearanceReferences.get('drawing')!;
  return { ui: render(<AppearancePanel />), original };
}

test('Edit restores removed PDF raster calibration and Save registration replaces once with real native corners and Undo (#4308)', async t => {
  if (!await nativeAvailable(t)) return;
  const { ui, original } = await fixture();
  click(button(ui, 'Edit Drawing 1')); await settle();
  const source = useViewerStore.getState().appearanceSources[0];
  assert.equal(source.assetId, original.assetId); assert.equal(source.pdf, undefined);
  assert.deepEqual(source.calibrationFrame?.rasterToSource, recipe.rasterToSource);
  const distance = ui.querySelector<HTMLInputElement>('input[aria-label="Distance A–B (m)"]'); assert.ok(distance);
  assert.equal(distance.value, '2');
  type(distance, '4'); await settle();
  assert.equal(useViewerStore.getState().appearanceReferences.get('drawing'), original, 'preview never repaints committed registration');
  const save = button(ui, 'Save registration'); assert.equal(save.disabled, false); click(save); await settle();
  const state = useViewerStore.getState(), updated = state.appearanceReferences.get('drawing')!;
  assert.equal(state.appearanceReferences.size, 1); assert.equal(state.referenceUndo.length, 2);
  assert.equal(updated.assetId, original.assetId); assert.equal(updated.opacity, 0.6);
  const expected = await calibrateAppearancePlane({ ...recipe, distanceMetres: 4 });
  assert.deepEqual(updated.cornersIfcWorld, expected.rasterCorners);
  act(() => useViewerStore.getState().replayAppearanceReference('undo'));
  assert.deepEqual(useViewerStore.getState().appearanceReferences.get('drawing'), original);
  act(() => useViewerStore.getState().replayAppearanceReference('redo'));
  assert.deepEqual(useViewerStore.getState().appearanceReferences.get('drawing'), updated);
});

test('Discard and concurrent reference change cannot overwrite a registered drawing (#4308)', async t => {
  if (!await nativeAvailable(t)) return;
  const { ui, original } = await fixture();
  click(button(ui, 'Edit Drawing 1')); await settle();
  const span = ui.querySelector<HTMLInputElement>('input[aria-label="Distance A–B (m)"]'); assert.ok(span);
  type(span, '5'); await settle();
  click(button(ui, 'Discard')); await settle();
  assert.equal(useViewerStore.getState().appearanceReferences.get('drawing'), original);
  click(button(ui, 'Edit Drawing 1')); await settle();
  assert.equal(ui.querySelector<HTMLInputElement>('input[aria-label="Distance A–B (m)"]')!.value, '2', 'Edit restores committed scale after discarded draft');
  act(() => useViewerStore.getState().updateAppearanceReference('drawing', { opacity: 0.4 }));
  click(button(ui, 'Save registration')); await settle();
  assert.match(ui.textContent!, /drawing changed/);
  assert.equal(useViewerStore.getState().appearanceReferences.get('drawing')!.opacity, 0.4);
  assert.equal(useViewerStore.getState().referenceUndo.length, 2, 'stale Save adds no command');
});

test('custom imported planes and missing recipes explicitly refuse lossy control restoration (#4308)', async t => {
  if (!await nativeAvailable(t)) return;
  const { original } = await fixture();
  assert.throws(() => referenceEditSettings({ ...original, calibration: undefined }), /no calibration recipe/);
  assert.throws(() => referenceEditSettings({ ...original, calibration: { ...recipe, planeNormal: [1, 1, 1] } }), /custom plane/);
  assert.throws(() => referenceEditSettings({ ...original, locked: true }), /Unlock/);
});

test('explicit source replacement retains both encoded images through Undo and never follows later source edits (#4308)', async t => {
  if (!await nativeAvailable(t)) return;
  const { ui, original } = await fixture();
  const otherPng = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const other = await appearanceAssets.add(otherPng, { owner });
  act(() => useViewerStore.getState().addAppearanceSource({ id: 'other', assetId: other.id, name: 'Replacement image',
    width: 1, height: 1, calibration: { sourcePoints: [[0,0],[1,0]], distanceMetres: 7 }, thumbnailUrl: 'blob:replacement' }));
  click(button(ui, 'Edit Drawing 1')); await settle();
  const select = ui.querySelector<HTMLSelectElement>('select[aria-label="Reuse a source"]'); assert.ok(select);
  act(() => { select.value = 'other'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await settle(); click(button(ui, 'Save registration')); await settle();
  const updated = useViewerStore.getState().appearanceReferences.get('drawing')!;
  assert.equal(updated.assetId, other.id); assert.equal(updated.calibration!.distanceMetres, 7);
  act(() => useViewerStore.getState().updateAppearanceSource({ ...useViewerStore.getState().appearanceSources.find(source => source.id === 'other')!, assetId: original.assetId }));
  assert.equal(useViewerStore.getState().appearanceReferences.get('drawing'), updated);
  act(() => useViewerStore.getState().replayAppearanceReference('undo'));
  assert.deepEqual(useViewerStore.getState().appearanceReferences.get('drawing'), original);
  assert.deepEqual(appearanceAssets.encoded(original.assetId), png);
  act(() => useViewerStore.getState().replayAppearanceReference('redo'));
  assert.deepEqual(useViewerStore.getState().appearanceReferences.get('drawing'), updated);
  assert.deepEqual(appearanceAssets.encoded(other.id), otherPng);
});

test('foreign-frame Edit previews explicit registration and Discard preserves the old frame until Save and Undo (#4308)', async t => {
  if (!await nativeAvailable(t)) return;
  const { ui, original } = await fixture();
  act(() => useViewerStore.setState({ modelPlacement: { ...emptyPlacementState(), frameKey: 'other-engineering-frame' } }));
  await settle();
  click(button(ui, 'Edit Drawing 1')); await settle();
  assert.equal(useViewerStore.getState().appearanceReferences.get('drawing'), original);
  click(button(ui, 'Discard')); await settle();
  assert.equal(useViewerStore.getState().appearanceReferences.get('drawing')!.frameKey, original.frameKey);
  click(button(ui, 'Edit Drawing 1')); await settle();
  const save = button(ui, 'Save registration'); assert.equal(save.disabled, false);
  click(save); await settle();
  const updated = useViewerStore.getState().appearanceReferences.get('drawing')!;
  assert.equal(updated.frameKey, 'other-engineering-frame');
  assert.equal(updated.assetId, original.assetId);
  act(() => useViewerStore.getState().replayAppearanceReference('undo'));
  assert.deepEqual(useViewerStore.getState().appearanceReferences.get('drawing'), original);
});
