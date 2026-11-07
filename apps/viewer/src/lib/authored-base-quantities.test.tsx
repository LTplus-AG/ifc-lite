/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authored elements on the Quantities tab (#9026 item 20): the store actions the
 * tools commit with, the panels that read them, undo, and the exported file.
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
import { SourceQuantityInspection } from '@/components/viewer/tools/SourceQuantityInspection';
import { MeasureQuantities } from '@/components/viewer/tools/MeasureQuantities';
import { commitElementSize } from '@/lib/element-size-commit';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { configureMutationView } from '@/utils/configureMutationView';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, render } from '@/test/render.js';

const s = () => useViewerStore.getState();
const made = (m: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in m, 'error' in m ? m.error : '');
  return m.expressId;
};
const select = (expressId: number) => act(() => {
  s().setSelectedEntity({ modelId: MODEL_ID, expressId });
  s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, expressId));
});
const dataStore = () => s().models.get(MODEL_ID)!.ifcDataStore as IfcDataStore;
const view = () => s().mutationViews.get(MODEL_ID)!;
const WALL = 'Qto_WallBaseQuantities';
const quantities = (id: number, set: string): Record<string, number> =>
  Object.fromEntries(view().getQuantitiesForEntity(id).find((q) => q.name === set)?.quantities.map((q) => [q.name, q.value]) ?? []);
const wall = () => made(s().addWall(MODEL_ID, STOREY, { Start: [0, 6, 0], End: [8, 6, 0], Thickness: 0.2, Height: 3 }));
const slab = () => made(s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 8, Depth: 6, Thickness: 0.25 }));
const roof = () => made(s().addRoof(MODEL_ID, STOREY, { Position: [0, 0, 3.3], Width: 8, Depth: 6, Thickness: 0.25 }));
const column = () => made(s().addColumn(MODEL_ID, STOREY, { Position: [1, 1, 0], Width: 0.3, Depth: 0.4, Height: 3 }));
const beam = () => made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 3, 3], End: [8, 3, 3], Width: 0.2, Height: 0.3 }));

let restoreRemesh: () => void;
beforeEach(async () => {
  configureMutationView(await seedModelingSession(), dataStore());
  restoreRemesh = setRequestRemesh(() => {});
  assert.equal(s().enterModelWorkspace(), true);
});
afterEach(() => { cleanup(); s().exitModelWorkspace(); restoreRemesh(); });

describe('the Quantities tab on an authored element', () => {
  for (const [kind, author, set] of [
    ['wall', wall, WALL],
    ['slab', slab, 'Qto_SlabBaseQuantities'],
    ['roof', roof, 'Qto_RoofBaseQuantities'],
    ['column', column, 'Qto_ColumnBaseQuantities'],
    ['beam', beam, 'Qto_BeamBaseQuantities'],
  ] as const) {
    it(`a ${kind} shows ${set} and no overlay warning`, async () => {
      const id = author();
      act(() => s().setPropertiesActiveTab('quantities'));
      select(id);
      const panel = render(<PropertiesPanel />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const text = panel.textContent ?? '';
      assert.ok(text.includes(set), `the panel names ${set}`);
      assert.doesNotMatch(text, /No quantities/);
      assert.doesNotMatch(text, /created in the overlay/);
    });
  }

  it('still warns for an authored kind it has no quantities for', async () => {
    const id = made(s().addMember(MODEL_ID, STOREY, { Start: [0, 3, 0], End: [0, 3, 3], Width: 0.1, Height: 0.1 }));
    act(() => s().setPropertiesActiveTab('quantities'));
    select(id);
    const panel = render(<SourceQuantityInspection />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(panel.textContent ?? '', /created in the overlay/);
  });

  it('a set gained by an edit clears the warning with no change of selection', async () => {
    const id = made(s().addMember(MODEL_ID, STOREY, { Start: [0, 3, 0], End: [0, 3, 3], Width: 0.1, Height: 0.1 }));
    select(id);
    const panel = render(<SourceQuantityInspection />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(panel.textContent ?? '', /created in the overlay/);
    act(() => { s().createQuantitySet(MODEL_ID, id, 'Qto_MemberBaseQuantities', [{ name: 'Length', value: 3, quantityType: QuantityType.Length }]); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.doesNotMatch(panel.textContent ?? '', /created in the overlay/);
  });

  it('the Measure Quantities tab reads the same numbers', async () => {
    select(wall());
    const panel = render(<MeasureQuantities />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const text = panel.textContent ?? '';
    assert.doesNotMatch(text, /created in the overlay/);
    assert.match(text, /4\.8\s*m³/, 'gross volume 8 x 0.2 x 3');
  });
});

describe('edits and undo', () => {
  it('a resize changes the values and undo restores them, one step', () => {
    const id = wall();
    const before = quantities(id, WALL);
    assert.equal(before.GrossVolume, 4.8);
    assert.equal(commitElementSize(useViewerStore, MODEL_ID, id, { kind: 'wall', height: 4 }).ok, true);
    assert.equal(quantities(id, WALL).GrossVolume, 6.4);
    s().undo(MODEL_ID);
    assert.deepEqual(quantities(id, WALL), before);
    s().redo(MODEL_ID);
    assert.equal(quantities(id, WALL).GrossVolume, 6.4);
  });

  it('a door lowers the net values and its undo restores them', () => {
    const id = wall();
    made(s().addHostedFill(MODEL_ID, id, { kind: 'door', params: { Offset: 2, Width: 1, Height: 2 } }));
    assert.deepEqual(
      [quantities(id, WALL).GrossVolume, quantities(id, WALL).NetVolume, quantities(id, WALL).NetSideArea],
      [4.8, 4.4, 22],
    );
    s().undo(MODEL_ID);
    assert.equal(quantities(id, WALL).NetVolume, 4.8);
  });

  it('adds no history of its own: authoring a wall records no quantity mutation', () => {
    wall();
    assert.deepEqual(view().getMutations().filter((m) => m.type.includes('QUANTITY')), []);
  });
});

describe('the export', () => {
  it('carries the tab\'s values after a resize, an undo and a door', async () => {
    const id = wall();
    commitElementSize(useViewerStore, MODEL_ID, id, { kind: 'wall', height: 4 });
    s().undo(MODEL_ID);
    s().addHostedFill(MODEL_ID, id, { kind: 'door', params: { Offset: 2, Width: 1, Height: 2 } });
    const { content } = new StepExporter(dataStore(), view()).export({ schema: 'IFC4', applyMutations: true });
    const text = new TextDecoder().decode(content);
    const reopened = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
    const set = extractQuantitiesOnDemand(reopened, id).find((q) => q.name === WALL);
    const fromFile = Object.fromEntries(set?.quantities.map((q) => [q.name, q.value]) ?? []);
    assert.deepEqual(fromFile, quantities(id, WALL));
    assert.equal(fromFile.Height, 3, 'the undone resize is not in the file');
    assert.equal(fromFile.NetVolume, 4.4, 'the door is');
  });
});
