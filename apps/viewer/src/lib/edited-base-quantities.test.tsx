/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Update quantities of edited elements" (#9026 item 20 follow-up) on a LOADED
 * element: a wall authored, exported and reopened, so its `Qto_WallBaseQuantities`
 * comes from the file. Resized with the store action the inspector commits
 * with, read on the Quantities tab, undone, and exported again, with the
 * setting off (the file's values stay) and on (they follow the geometry).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { QuantityType } from '@ifc-lite/data';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { commitElementSize } from '@/lib/element-size-commit';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { configureMutationView } from '@/utils/configureMutationView';
import { applyEditedQuantityRefresh } from '@/hooks/useEditedQuantityRefresh';
import {
  EDITED_QUANTITY_REFRESH_STORAGE_KEY,
  isEditedQuantityRefreshEnabled,
  reloadEditedQuantityRefreshForTests,
} from '@/lib/quantities/edited-quantity-refresh';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, render } from '@/test/render.js';

const s = () => useViewerStore.getState();
const WALL = 'Qto_WallBaseQuantities';
const dataStore = () => s().models.get(MODEL_ID)!.ifcDataStore as IfcDataStore;
const view = () => s().mutationViews.get(MODEL_ID)!;
const quantities = (id: number): Record<string, number> =>
  Object.fromEntries(view().getQuantitiesForEntity(id).find((q) => q.name === WALL)?.quantities.map((q) => [q.name, q.value]) ?? []);
const exportText = () => new TextDecoder().decode(new StepExporter(dataStore(), view()).export({ schema: 'IFC4', applyMutations: true }).content);
async function fileQuantities(text: string, id: number): Promise<Record<string, number>> {
  const reopened = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
  const sets = extractQuantitiesOnDemand(reopened, id).filter((q) => q.name === WALL);
  assert.equal(sets.length, 1, `the file has one ${WALL}`);
  return Object.fromEntries(sets[0].quantities.map((q) => [q.name, q.value]));
}
const resize = (id: number, height: number) =>
  assert.equal(commitElementSize(useViewerStore, MODEL_ID, id, { kind: 'wall', height }).ok, true);

/** The authored wall as a file: author 8 x 0.2 x 3 m, export, and load the export. */
let loadedFile = '';
let wallId = 0;
async function loadAuthoredWall(): Promise<void> {
  if (!loadedFile) {
    configureMutationView(await seedModelingSession(), dataStore());
    assert.equal(s().enterModelWorkspace(), true);
    const made = s().addWall(MODEL_ID, STOREY, { Start: [0, 6, 0], End: [8, 6, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in made);
    wallId = made.expressId;
    loadedFile = exportText();
    s().exitModelWorkspace();
  }
  configureMutationView(await seedModelingSession({ step: loadedFile }), dataStore());
  assert.equal(s().enterModelWorkspace(), true);
  assert.ok(!view().getNewEntity(wallId), 'the wall is the file\'s now');
}

let restoreRemesh: () => void;
beforeEach(async () => {
  localStorage.removeItem(EDITED_QUANTITY_REFRESH_STORAGE_KEY);
  reloadEditedQuantityRefreshForTests();
  restoreRemesh = setRequestRemesh(() => {});
  await loadAuthoredWall();
});
afterEach(() => {
  cleanup();
  s().exitModelWorkspace();
  restoreRemesh();
  applyEditedQuantityRefresh(false);
});

describe('the setting', () => {
  it('is off by default and remembered in this browser', () => {
    assert.equal(isEditedQuantityRefreshEnabled(), false);
    applyEditedQuantityRefresh(true);
    assert.equal(localStorage.getItem(EDITED_QUANTITY_REFRESH_STORAGE_KEY), 'true');
    reloadEditedQuantityRefreshForTests();
    assert.equal(isEditedQuantityRefreshEnabled(), true, 'a fresh page load reads it back');
  });

  it('turning it on writes nothing to the overlay or its history', () => {
    const before = view().getMutations().length;
    applyEditedQuantityRefresh(true);
    assert.equal(view().getMutations().length, before);
  });
});

describe('a loaded wall, resized', () => {
  it('off: the tab and the export keep the file\'s values (as before this setting)', async () => {
    const file = quantities(wallId);
    assert.equal(file.Height, 3);
    resize(wallId, 4);
    assert.deepEqual(quantities(wallId), file);
    assert.deepEqual(await fileQuantities(exportText(), wallId), file);
  });

  it('on: the tab and the export follow the geometry', async () => {
    applyEditedQuantityRefresh(true);
    resize(wallId, 4);
    const tab = quantities(wallId);
    assert.deepEqual([tab.Height, tab.GrossSideArea, tab.GrossVolume], [4, 32, 6.4]);
    assert.deepEqual(await fileQuantities(exportText(), wallId), tab);
  });

  it('on, unedited: nothing is refreshed and the export carries the file\'s set as it was', async () => {
    applyEditedQuantityRefresh(true);
    const tab = quantities(wallId);
    assert.equal(tab.Height, 3);
    const body = (text: string) => text.slice(text.indexOf('DATA;'));
    const on = exportText();
    applyEditedQuantityRefresh(false);
    assert.equal(body(on), body(exportText()), 'an unedited file exports the same with the setting on or off');
  });

  it('turning it on after the edit refreshes, and off again restores the file\'s values', () => {
    const file = quantities(wallId);
    resize(wallId, 4);
    applyEditedQuantityRefresh(true);
    assert.equal(quantities(wallId).Height, 4);
    applyEditedQuantityRefresh(false);
    assert.deepEqual(quantities(wallId), file);
  });

  it('undo and redo move the refresh with the geometry', () => {
    applyEditedQuantityRefresh(true);
    const file = quantities(wallId);
    resize(wallId, 4);
    assert.equal(quantities(wallId).GrossVolume, 6.4);
    s().undo(MODEL_ID);
    assert.deepEqual(quantities(wallId), file);
    s().redo(MODEL_ID);
    assert.equal(quantities(wallId).GrossVolume, 6.4);
  });

  it('a person\'s own edit of a quantity wins over the refresh, in the tab and the file', async () => {
    applyEditedQuantityRefresh(true);
    resize(wallId, 4);
    act(() => { s().setQuantity(MODEL_ID, wallId, WALL, 'Height', 9, QuantityType.Length); });
    assert.equal(quantities(wallId).Height, 9);
    assert.equal(quantities(wallId).GrossVolume, 6.4, 'the rest still follows the geometry');
    assert.equal((await fileQuantities(exportText(), wallId)).Height, 9);
  });

  it('a person\'s deletion of the set wins over the refresh', async () => {
    applyEditedQuantityRefresh(true);
    resize(wallId, 4);
    view().deleteQuantitySet(wallId, WALL);
    assert.deepEqual(quantities(wallId), {});
    const reopened = await new IfcParser().parseColumnar(new TextEncoder().encode(exportText()).buffer as ArrayBuffer, { disableWorkerScan: true });
    assert.equal(extractQuantitiesOnDemand(reopened, wallId).some((q) => q.name === WALL), false);
  });
});

describe('the Quantities tab', () => {
  const select = (expressId: number) => act(() => {
    s().setSelectedEntity({ modelId: MODEL_ID, expressId });
    s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, expressId));
    s().setPropertiesActiveTab('quantities');
  });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  it('offers the switch on a loaded wall, and marks the set it refreshed', async () => {
    resize(wallId, 4);
    select(wallId);
    const panel = render(<PropertiesPanel />);
    await settle();
    const toggle = panel.querySelector('#quantities-update-edited');
    assert.ok(toggle, 'the switch is on the tab');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.doesNotMatch(panel.textContent ?? '', /Updated from geometry/, 'off: the set reads as the file wrote it');
    act(() => { (toggle as HTMLElement).click(); });
    await settle();
    assert.equal(isEditedQuantityRefreshEnabled(), true);
    assert.match(panel.textContent ?? '', /Updated from geometry/);
    assert.match(panel.textContent ?? '', /6\.4/, 'and shows the refreshed volume');
  });
});
