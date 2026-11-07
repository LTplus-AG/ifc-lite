/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { LocalBackend } from '@/sdk/local-backend';
import { getLocale, registerLocale, setLocale } from '@/i18n';
import { commandPaletteDe } from '@/i18n/locales/de/command-palette';
import { commandPaletteRu } from '@/i18n/locales/ru/command-palette';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { activeVisibilityReasons, resetVisibilityReasons } from '@/lib/visibility/visibility-reasons';
import { MODEL_ID, MESH_WALL, ROTATED_BEAM, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, click, press, render, type as typeInto } from '@/test/render';
import { CommandPalette } from './CommandPalette';
import { RECENT_KEY } from './commandPaletteSearch';

// #8947 C1242/N1269: contextual reset is a distinct action from Show all.
// Parsed IFC and the actual store/SDK actions; no GPU or runtime acceptance claim.
const initial = useViewerStore.getState();
const locale = getLocale();
const sdk = createBimContext({ backend: new LocalBackend(useViewerStore) });
const resetId = 'vis:reset-filters';
beforeEach(async () => {
  setLocale('en'); localStorage.clear();
  await seedModelingSession();
  resetVisibilityReasons(useViewerStore);
  useViewerStore.setState({ collabRole: null, loading: false });
});
afterEach(() => {
  cleanup(); useViewerStore.setState(initial, true);
  setLocale(locale); localStorage.clear();
});
function mount() {
  let closes = 0;
  render(<BimReactContext.Provider value={sdk}>
    <CommandPalette open onOpenChange={() => { closes++; }} />
  </BimReactContext.Provider>);
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]'); assert.ok(input);
  return { input, closes: () => closes };
}
function row(id = resetId) {
  const option = document.querySelector<HTMLElement>(`[role="option"][data-command-id="${id}"]`);
  assert.ok(option, `${id} is discoverable`); return option;
}
function exists() {
  return document.querySelector(`[role="option"][data-command-id="${resetId}"]`) !== null;
}
function heldFrames(run: (flush: () => void) => void) {
  const original = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  try { run(() => act(() => { for (const frame of frames.splice(0)) frame(0); })); }
  finally { globalThis.requestAnimationFrame = original; }
}
function qualify(federated: boolean) {
  if (federated) {
    const model = useViewerStore.getState().models.get(MODEL_ID)!;
    useViewerStore.setState({ models: new Map([
      [MODEL_ID, { ...model, idOffset: 1_000_000 }],
      ['peer', { ...model, id: 'peer', idOffset: 2_000_000 }],
    ]) });
  }
  const modelId = federated ? 'peer' : MODEL_ID;
  const models = useViewerStore.getState().models;
  return { modelId, manual: toGlobalIdFromModels(models, modelId, MESH_WALL),
    lens: toGlobalIdFromModels(models, modelId, ROTATED_BEAM) };
}
for (const federated of [false, true]) {
  const scope = federated ? 'N models' : '1 model';
  test(`#8947 contextual reset keeps selection/collection/lens/type preferences; Show all clears selection/collection (${scope})`, () => {
    const { modelId, manual, lens } = qualify(federated);
    const s = useViewerStore.getState();
    s.setBasket([{ modelId, expressId: MESH_WALL }]);
    s.setSelectedEntityId(manual); s.setSelectedEntityIds([manual]);
    useViewerStore.setState({ selectedEntity: { modelId, expressId: MESH_WALL },
      activeLensId: 'lens', lensHiddenIds: new Set([lens]), lensAppliedHiddenIds: [lens],
      hiddenEntities: new Set([manual, lens]),
      typeVisibility: { ...s.typeVisibility, site: false },
      typeViewMode: 'types', hasTypeGeometry: true,
      hostHiddenIfcTypes: new Set(['IFCSPACE']), clashSelectedId: 'focused-clash' });
    useViewerStore.getState().setModelsVisibility([modelId], false);
    const before = useViewerStore.getState();
    assert.equal(before.selectedEntityId, manual);
    assert.ok(before.selectedEntityIds.has(manual));
    assert.equal(before.models.get(modelId)?.ifcDataStore?.entities.getTypeName(MESH_WALL), 'IfcWall');
    const { input } = mount();
    typeInto(input, 'reset visibility filters');
    assert.match(row().textContent ?? '', /Keep selection and collection/);
    assert.notEqual(row().getAttribute('aria-disabled'), 'true');
    heldFrames(flush => { press(input, 'Enter'); flush(); });
    const after = useViewerStore.getState();
    assert.deepEqual(after.hiddenEntities, new Set([lens]), 'manual hide clears; lens hide remains');
    assert.ok([...after.models.values()].every(model => model.visible), 'model hide clears');
    assert.equal(after.isolatedEntities, null, 'basket isolation clears, collection survives');
    assert.equal(after.selectedEntityId, before.selectedEntityId);
    assert.deepEqual(after.selectedEntityIds, before.selectedEntityIds);
    assert.deepEqual(after.selectedEntity, before.selectedEntity);
    assert.deepEqual(after.pinboardEntities, before.pinboardEntities);
    assert.ok(after.pinboardEntities.size > 0);
    assert.equal(after.activeLensId, 'lens');
    assert.deepEqual(after.typeVisibility, before.typeVisibility);
    assert.equal(after.typeViewMode, 'types');
    assert.deepEqual(after.hostHiddenIfcTypes, before.hostHiddenIfcTypes);
    assert.equal(after.clashSelectedId, 'focused-clash');
    assert.ok(activeVisibilityReasons(after).every(reason => reason.resetPolicy === 'kept'));
    typeInto(input, 'Show all');
    heldFrames(flush => { click(row('vis:show')); flush(); });
    const shown = useViewerStore.getState();
    assert.equal(shown.selectedEntityId, null);
    assert.equal(shown.selectedEntityIds.size, 0);
    assert.equal(shown.pinboardEntities.size, 0);
    assert.equal(shown.clashSelectedId, null);
  });

  test(`#8947 inactive reset is search-only with live refusal/recovery and deferred recheck (${scope})`, () => {
    const { manual, lens } = qualify(federated);
    localStorage.setItem(RECENT_KEY, JSON.stringify([resetId]));
    const ui = mount();
    assert.equal(exists(), false, 'absent from both browse and recents');
    typeInto(ui.input, 'restore visibility without clearing selection');
    assert.equal(row().getAttribute('aria-disabled'), 'true');
    assert.match(row().textContent ?? '', /No visibility filters to reset/);
    click(row()); press(ui.input, 'Enter');
    assert.equal(ui.closes(), 0, 'refusal keeps palette open');
    // This channel was absent from the old prerequisite snapshot: tests live projection.
    act(() => useViewerStore.setState({ ghostExceptEntities: new Set([manual]) }));
    assert.notEqual(row().getAttribute('aria-disabled'), 'true');
    typeInto(ui.input, '');
    assert.equal(document.querySelectorAll(`[role="option"][data-command-id="${resetId}"]`).length, 2,
      'available action appears in browse and recents');
    act(() => useViewerStore.getState().clearGhost());
    assert.equal(exists(), false, 'both inactive browse entries disappear without reopening');
    typeInto(ui.input, 'reset visibility filters');
    act(() => useViewerStore.setState({ ghostExceptEntities: new Set([manual]) }));
    localStorage.removeItem(RECENT_KEY);
    heldFrames(flush => {
      click(row());
      act(() => useViewerStore.setState({ ghostExceptEntities: null, activeLensId: 'lens',
        lensHiddenIds: new Set([lens]), lensAppliedHiddenIds: [], hiddenEntities: new Set() }));
      flush();
    });
    assert.equal(useViewerStore.getState().hiddenEntities.size, 0,
      'stale activation refuses: reset would otherwise reconcile pending lens hides');
    assert.equal(localStorage.getItem(RECENT_KEY), null, 'refused frame records no successful usage');
    assert.equal(row().getAttribute('aria-disabled'), 'true');
    act(() => useViewerStore.setState({ ghostExceptEntities: new Set([manual]) }));
    heldFrames(flush => { click(row()); flush(); });
    assert.equal(useViewerStore.getState().ghostExceptEntities, null, 'fresh live recovery executes real reset');
    assert.deepEqual(useViewerStore.getState().hiddenEntities, new Set([lens]));
    assert.equal(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')[0], resetId);
  });
}

test('#8947 unloaded reset retains the model prerequisite even with a stale filter', () => {
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, geometryResult: null,
    hiddenEntities: new Set([MESH_WALL]) });
  const ui = mount(); typeInto(ui.input, 'reset visibility filters');
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  assert.match(row().textContent ?? '', /Load a model first/);
  click(row()); press(ui.input, 'Enter');
  assert.equal(ui.closes(), 0);
  assert.deepEqual(useViewerStore.getState().hiddenEntities, new Set([MESH_WALL]));
});

for (const [lang, catalogue, alias] of [
  ['de', commandPaletteDe, 'Sichtbarkeit wiederherstellen ohne Auswahl zu löschen'],
  ['ru', commandPaletteRu, 'восстановить видимость без очистки выбора'],
] as const) {
  test(`#8947 reset has searchable localized task aliases and live text (${lang})`, () => {
    registerLocale(lang, catalogue);
    const ui = mount(); typeInto(ui.input, 'reset visibility filters');
    act(() => setLocale(lang));
    typeInto(ui.input, alias);
    assert.ok(row().textContent?.includes(catalogue['commandPalette.vis.resetFilters.label']));
    assert.ok(row().textContent?.includes(catalogue['commandPalette.vis.resetFilters.detail']));
    assert.ok(row().textContent?.includes(catalogue['commandPalette.availability.noVisibilityFilters']));
    assert.equal(row().getAttribute('aria-disabled'), 'true');
  });
}
