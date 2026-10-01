/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ComponentProps } from 'react';
import { render, click, advance, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import { emptyPlacementState } from '@/lib/model-placement/state';
// Let the production-only revert reach the mounted workflow assertion when
// the new panel is removed, rather than failing at module collection.
const underlays = await import('./DrawingUnderlaysPanel').catch((error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error
    && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) return null;
  throw error;
});
function DrawingUnderlaysPanel(props: ComponentProps<NonNullable<typeof underlays>['DrawingUnderlaysPanel']>) {
  assert.ok(underlays, 'Section Underlays must expose the shared reference workflow.');
  return <underlays.DrawingUnderlaysPanel {...props} />;
}
import { AppearancePanel } from '../appearance/AppearancePanel';
import { AppearanceReferenceLibrary } from '../appearance/AppearanceReferenceLibrary';

const initial = useViewerStore.getState();
const owner = { kind: 'source' as const, id: 'underlay-entry-fixture' };
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const side = { axis: 'x' as const, position: 5, flipped: false };
function reset() {
  useViewerStore.setState({ models: new Map(), activeModelId: null, geometryResult: null, modelPlacement: emptyPlacementState(),
    appearanceReferenceEntry: null, appearanceDraft: null, appearanceSources: [], appearanceReferences: new Map(),
    referenceUndo: [], referenceRedo: [], referenceRevision: 0, collabRoomId: null, dxfUnderlays: [], drawing2D: null });
}
afterEach(() => {
  cleanup();
  for (const source of useViewerStore.getState().appearanceSources) useViewerStore.getState().removeAppearanceSource(source.id);
  reset(); appearanceAssets.releaseOwner(owner); useViewerStore.setState(initial, true);
});
function button(ui: HTMLElement, name: string) {
  const result = [...ui.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === name || element.getAttribute('aria-label') === name);
  assert.ok(result, name); return result;
}

test('Side Underlays enters reference intent on the frozen cut before source upload (#6615)', async () => {
  reset();
  const ui = render(<DrawingUnderlaysPanel sectionPlane={side} planViewActive={false} georeferenceAvailable={false} onCenterOnModel={() => {}} />);
  click(button(ui, 'Import PDF/image...'));
  const panel = render(<AppearancePanel />);
  assert.equal(useViewerStore.getState().appearanceReferenceEntry, null, 'entry is consumed once after opening');
  const draft = useViewerStore.getState().appearanceDraft;
  assert.equal(draft?.intent, 'reference');
  assert.equal(draft?.settings.plane, 'yz');
  assert.equal(draft?.settings.offsetU, 5, 'Side cut maps to IFC X at requested engineering distance');
  assert.equal(draft?.settings.repeatS, false);
  act(() => useViewerStore.getState().setSectionPlanePosition(90));
  assert.equal(useViewerStore.getState().appearanceDraft?.settings.offsetU, 5, 'moving the live cut does not retarget an open upload');
  const input = panel.querySelector<HTMLInputElement>('input[accept*="application/pdf"]');
  assert.ok(input, 'existing Appearance PDF picker is available before upload');
  const transfer = new window.DataTransfer(); transfer.items.add(new window.File([png], 'section.png', { type: 'image/png' }));
  Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  for (let i=0;i<100 && !useViewerStore.getState().appearanceSources.length;i++) await advance(10);
  assert.equal(useViewerStore.getState().appearanceSources.length, 1, 'upload uses existing source inventory');
  assert.equal(useViewerStore.getState().appearanceDraft?.intent, 'reference', 'upload does not fall back to IFC authoring');
  assert.equal(useViewerStore.getState().appearanceDraft?.settings.offsetU, 5);
  assert.equal(button(panel, 'Place reference').disabled, true, 'unmeasured image cannot be placed');
  assert.equal(useViewerStore.getState().appearanceReferences.size, 0, 'upload alone never commits a registration');
});

test('Underlays and Appearance share committed rows, visibility history, and edge-on status (#6615)', async () => {
  reset();
  const asset = await appearanceAssets.add(png, { owner });
  useViewerStore.getState().addAppearanceReference({ id: 'r', sourceId: 'section', assetId: asset.id,
    cornersIfcWorld: [[5,0,0],[5,2,0],[5,2,3],[5,0,3]], frameKey: placementFrameKey(useViewerStore.getState()),
    visible: true, locked: false, opacity: 1 });
  const ui = render(<DrawingUnderlaysPanel sectionPlane={side} planViewActive={false} georeferenceAvailable={false} onCenterOnModel={() => {}} />);
  const library = render(<AppearanceReferenceLibrary plane={{ axis:'y',position:0,flipped:false }} />);
  assert.doesNotMatch(ui.textContent!, /edge-on/);
  assert.match(library.textContent!, /edge-on/);
  click(button(ui, 'Hide Drawing 1'));
  assert.ok(button(library, 'Show Drawing 1'), 'other library reflects the same registration');
  assert.equal(useViewerStore.getState().referenceUndo.length, 2, 'visibility uses existing undoable reference command');
  click(button(library, 'Remove Drawing 1'));
  assert.match(ui.textContent!, /Registered drawings will appear here/);
});


test('an already mounted Appearance panel consumes a section request and cancels IFC intent before upload (#6615)', () => {
  reset();
  const panel = render(<AppearancePanel />);
  assert.equal(useViewerStore.getState().appearanceDraft?.intent, 'apply');
  const ui = render(<DrawingUnderlaysPanel sectionPlane={{ axis: 'z', position: 7, flipped: true }} planViewActive={false} georeferenceAvailable={false} onCenterOnModel={() => {}} />);
  click(button(ui, 'Import PDF/image...'));
  assert.equal(useViewerStore.getState().appearanceDraft?.intent, 'reference');
  assert.equal(useViewerStore.getState().appearanceDraft?.settings.plane, 'xz');
  assert.equal(useViewerStore.getState().appearanceDraft?.settings.offsetV, -7, 'Y-up Z maps to negative IFC Y');
  assert.equal(useViewerStore.getState().appearanceReferenceEntry, null);
  assert.ok(panel.querySelector<HTMLInputElement>('input[accept*="application/pdf"]'));
  assert.equal(button(panel, 'Place reference').disabled, true);
});

test('an unopened section import request dies on model clear and session reset (#6615)', () => {
  reset();
  const ui = render(<DrawingUnderlaysPanel sectionPlane={side} planViewActive={false} georeferenceAvailable={false} onCenterOnModel={() => {}} />);
  click(button(ui, 'Import PDF/image...'));
  act(() => useViewerStore.getState().clearAllModels());
  render(<AppearancePanel />);
  assert.equal(useViewerStore.getState().appearanceDraft?.intent, 'apply', 'clearing models before the lazy panel mounts cannot replay an old section request');
  assert.equal(useViewerStore.getState().appearanceReferenceEntry, null);
  cleanup();
  reset();
  const next = render(<DrawingUnderlaysPanel sectionPlane={side} planViewActive={false} georeferenceAvailable={false} onCenterOnModel={() => {}} />);
  click(button(next, 'Import PDF/image...'));
  act(() => useViewerStore.getState().resetViewerState());
  assert.equal(useViewerStore.getState().appearanceReferenceEntry, null);
});
