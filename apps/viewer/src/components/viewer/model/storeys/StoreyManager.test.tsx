/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9013: the storey manager as a person uses it. Highest first with the
 * active storey marked; add above in one click and draw on it; inline edits
 * commit on Enter, cancel on Escape and explain a refusal next to the field;
 * an empty storey deletes straight away, one with elements asks first.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { advance, cleanup, click, press, render, type, waitFor } from '@/test/render.js';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { requiredModule } from '@/i18n/__tests__/required-module';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { Toaster } from '@/components/ui/toast';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { toGlobalIdFromModels } from '@/store/globalId';

let restore: () => void = () => {};
beforeEach(async () => {
  await seedModelingSession();
  restore = setRequestRemesh(() => {});
  useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: STOREY });
});
afterEach(() => { restore(); cleanup(); useViewerStore.getState().exitModelWorkspace(); });

const rows = (ui: HTMLElement) => [...ui.querySelectorAll<HTMLElement>('[data-storey-row]')];
const field = (row: HTMLElement, name: string) => row.querySelector<HTMLInputElement>(`[data-storey-field="${name}"]`)!;
const elevations = () => modelStoreys(useViewerStore.getState(), MODEL_ID).map((s) => s.elevation);

async function mount() {
  // Loaded here so a production revert fails an assertion, not the file load (#9013).
  const { StoreyManager } = await requiredModule(() => import('./StoreyManager'), 'the storey manager exists (#9013)');
  const ui = render(<StoreyManager onBack={() => {}} />);
  await waitFor(() => rows(ui).length > 0, 'the rows load');
  return ui;
}

function edit(input: HTMLInputElement, text: string) {
  act(() => input.focus());
  type(input, text);
}

describe('storey manager (#9013)', () => {
  it('lists storeys highest first with height and count; the active storey is the checked radio', async () => {
    const ui = await mount();
    assert.deepEqual(rows(ui).map((row) => field(row, 'name').value), ['L1', 'L0']);
    const [upper, ground] = rows(ui);
    assert.equal(upper.dataset.storeyRow, String(UPPER_STOREY));
    assert.equal(field(ground, 'elevation').value, '±0.00');
    assert.equal(field(ground, 'height').value, '3.00');
    assert.equal(field(upper, 'height'), null, 'the top storey has no floor-to-floor height to edit');
    assert.equal(ground.querySelector('[role="radio"]')?.getAttribute('aria-checked'), 'true');
    // One click on the row switches the storey being drawn on.
    act(() => click(upper.querySelector('[role="radio"]')!));
    assert.equal(useViewerStore.getState().session?.storeyId, UPPER_STOREY);
  });

  it('an isolated storey hands its isolation to the storey picked or added in the manager (#9037 review)', async () => {
    const soloOn = (storeyId: number) => {
      const st = useViewerStore.getState();
      return st.levelDisplayMode === 'solo' && st.selectedStoreys.has(toGlobalIdFromModels(st.models, MODEL_ID, storeyId));
    };
    act(() => applyLevelDisplayMode('solo', [{ modelId: MODEL_ID, expressId: STOREY }]));
    const ui = await mount();
    act(() => click(rows(ui)[0].querySelector('[role="radio"]')!));
    assert.equal(useViewerStore.getState().session?.storeyId, UPPER_STOREY);
    assert.equal(soloOn(UPPER_STOREY), true, 'the storey now drawn on is the one shown');
    assert.equal(soloOn(STOREY), false);
    const add = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Add storey above'))!;
    act(() => click(add));
    await waitFor(() => rows(ui).length === 3, 'the new row appears');
    const created = useViewerStore.getState().session!.storeyId!;
    assert.equal(soloOn(created), true, 'a new storey drawn on straight away is shown too');
  });

  it('a model with no editable data is a read error, not a model without storeys (#9037 review)', async () => {
    const { StoreyManager } = await requiredModule(() => import('./StoreyManager'), 'the storey manager exists (#9013)');
    const models = new Map([...useViewerStore.getState().models].map(([id, model]) => [id, { ...model, ifcDataStore: null }]));
    act(() => { useViewerStore.setState({ models }); });
    const ui = render(<StoreyManager onBack={() => {}} />);
    await waitFor(() => ui.querySelector('[role="alert"]') !== null, 'the read error shows');
    assert.match(ui.querySelector('[role="alert"]')!.textContent ?? '', /No model loaded/);
    assert.equal([...ui.querySelectorAll('button')].some((b) => b.textContent?.includes('±0.00')), false, 'no offer to add a first storey');
  });

  it('adds a storey above in one click; it becomes active with the next name and spacing', async () => {
    const ui = await mount();
    const add = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Add storey above'))!;
    act(() => click(add));
    await waitFor(() => rows(ui).length === 3, 'the new row appears');
    assert.deepEqual(elevations(), [0, 1.5, 3], 'above L0, under L1: the gap is split');
    const created = useViewerStore.getState().session?.storeyId;
    assert.ok(created !== STOREY && created !== UPPER_STOREY);
    assert.equal(rows(ui)[1].querySelector('[role="radio"]')?.getAttribute('aria-checked'), 'true');
  });

  it('Enter commits a floor-to-floor height; the storeys above move', async () => {
    const ui = await mount();
    const height = field(rows(ui)[1], 'height');
    edit(height, '3500 mm');
    press(height, 'Enter');
    await waitFor(() => elevations()[1] === 3.5, 'L1 rises to 3.50');
    assert.equal(ui.querySelector('[role="alert"]'), null);
  });

  it('Enter keeps a previewed edit: the preview already shows the typed value (GPU walkthrough regression)', async () => {
    const ui = await mount();
    const height = field(rows(ui)[1], 'height');
    edit(height, '3.50');
    await advance(400);
    assert.deepEqual(elevations(), [0, 3.5], 'the preview applied the edit');
    // The row now displays 3.50, the very text typed: that is still a change from 3.00.
    press(height, 'Enter');
    await advance(50);
    assert.deepEqual(elevations(), [0, 3.5], 'Enter kept the preview');
    const s = useViewerStore.getState();
    const stack = s.undoStacks.get(MODEL_ID) ?? [];
    const tags = stack.map((m) => s.mutationBatchTags.get(m.id));
    assert.ok(stack.length > 0 && tags.every((tag) => tag !== undefined), 'every record carries a batch tag');
    assert.equal(new Set(tags).size, 1, 'one undo step');
  });

  it('Escape cancels a previewed elevation: the model is as it was', async () => {
    const ui = await mount();
    const elevation = field(rows(ui)[0], 'elevation');
    edit(elevation, '3.4');
    await advance(400);
    assert.deepEqual(elevations(), [0, 3.4], 'the preview shows the edit before it is applied');
    assert.match(ui.querySelector('[data-storey-impact-summary]')?.textContent ?? '', /Moves 1 storey/);
    press(elevation, 'Escape');
    assert.deepEqual(elevations(), [0, 3]);
    assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0, 0, 'nothing reached the undo history');
  });

  it('explains a refused value next to the field and keeps the model unchanged', async () => {
    const ui = await mount();
    const elevation = field(rows(ui)[0], 'elevation');
    edit(elevation, '-1');
    await advance(400);
    press(elevation, 'Enter');
    const alert = ui.querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? '', /L1 would pass L0 \(±0\.00 m\) below it/);
    assert.equal(elevation.getAttribute('aria-invalid'), 'true');
    assert.deepEqual(elevations(), [0, 3]);
    edit(elevation, 'three');
    assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /Enter a length/);
  });

  it('a refused rename is explained beside the name field, and typing clears it (#9037 review)', async () => {
    const ui = await mount();
    const name = field(rows(ui)[1], 'name');
    edit(name, '   ');
    press(name, 'Enter');
    assert.equal(name.getAttribute('aria-invalid'), 'true');
    const alert = rows(ui)[1].querySelector('[role="alert"]');
    assert.equal(alert?.textContent, 'A storey needs a name');
    assert.equal(rows(ui)[0].querySelector('[role="alert"]'), null, 'only the refused row says so');
    assert.equal(modelStoreys(useViewerStore.getState(), MODEL_ID)[0].name, 'L0', 'nothing was renamed');
    type(name, 'Ground');
    assert.equal(rows(ui)[1].querySelector('[role="alert"]'), null);
    press(name, 'Enter');
    assert.equal(modelStoreys(useViewerStore.getState(), MODEL_ID)[0].name, 'Ground');
  });

  it('deletes an empty storey straight away, with Undo', async () => {
    const ui = await mount();
    const remove = rows(ui)[0].querySelector<HTMLButtonElement>('button[aria-label^="Delete"]')!;
    act(() => click(remove));
    await waitFor(() => rows(ui).length === 1, 'the storey is gone');
    act(() => useViewerStore.getState().undo(MODEL_ID));
    await waitFor(() => rows(ui).length === 2, 'Undo brings it back');
  });

  it('the deletion toast undoes that deletion only, never a later edit (#9037 review)', async () => {
    const { StoreyManager } = await requiredModule(() => import('./StoreyManager'), 'the storey manager exists (#9013)');
    const ui = render(<><StoreyManager onBack={() => {}} /><Toaster /></>);
    await waitFor(() => rows(ui).length > 0, 'the rows load');
    const undoButton = () => [...document.body.querySelectorAll('button')].filter((b) => b.textContent === 'Undo').at(-1);
    const deleteTop = async () => {
      act(() => click(rows(ui)[0].querySelector<HTMLButtonElement>('button[aria-label^="Delete"]')!));
      await waitFor(() => rows(ui).length === 1 && undoButton() !== undefined, 'the storey is gone, with Undo');
    };
    // With nothing after it, the toast's Undo brings the storey back.
    await deleteTop();
    act(() => click(undoButton()!));
    await waitFor(() => rows(ui).length === 2, 'Undo brings it back');
    await deleteTop();
    const later = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in later));
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    act(() => click(undoButton()!));
    assert.equal(view.isDeleted(later.expressId), false, 'the later wall stays');
    assert.equal(rows(ui).length, 1, 'the storey stays deleted');
    await waitFor(() => (document.body.textContent ?? '').includes('Not undone: later edits came after this deletion'), 'the toast says why');
  });

  it('deletion choices opened in one model are not offered for another model with the same storey ids (#9037 review)', async () => {
    const wall = useViewerStore.getState().addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    const first = useViewerStore.getState().models.get(MODEL_ID)!;
    const firstView = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    const second = { ...first, id: 'structural', name: 'Structural' };
    const secondView = new MutablePropertyView(second.ifcDataStore!.properties, second.id);
    act(() => {
      useViewerStore.setState({
        models: new Map([[first.id, first], [second.id, second]]),
        mutationViews: new Map([[first.id, firstView], [second.id, secondView]]),
      });
    });
    const ui = await mount();
    act(() => click(rows(ui)[0].querySelector<HTMLButtonElement>('button[aria-label^="Delete"]')!));
    assert.ok(ui.querySelector('[data-storey-delete-panel]'), 'the choices open for L1 of the first model');
    act(() => {
      useViewerStore.getState().exitModelWorkspace();
      useViewerStore.getState().enterModelWorkspace({ modelId: second.id, storeyId: STOREY });
    });
    assert.equal(ui.querySelector('[data-storey-delete-panel]'), null, 'the second model\'s L1 was never reviewed');
    await waitFor(() => rows(ui).length > 0, 'the second model\'s rows load');
    assert.equal(ui.querySelector('[data-storey-delete-panel]'), null, 'nor once its rows have loaded');
  });

  it('another model\'s rows are never shown for the model just switched to (#9037 review)', async () => {
    const first = useViewerStore.getState().models.get(MODEL_ID)!;
    const firstView = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    const second = { ...first, id: 'structural', name: 'Structural' };
    const secondView = new MutablePropertyView(second.ifcDataStore!.properties, second.id);
    act(() => {
      useViewerStore.setState({
        models: new Map([[first.id, first], [second.id, second]]),
        mutationViews: new Map([[first.id, firstView], [second.id, secondView]]),
      });
    });
    const ui = await mount();
    act(() => {
      useViewerStore.getState().exitModelWorkspace();
      useViewerStore.getState().enterModelWorkspace({ modelId: second.id, storeyId: STOREY });
    });
    // Before the second model's own read lands, nothing is listed (or deletable) for it.
    assert.equal(rows(ui).length, 0, 'the first model\'s rows are gone at once');
    await waitFor(() => rows(ui).length > 0, 'the second model\'s rows load');
  });

  it('a refused rename in one model is not shown on another model\'s storey with the same id (#9037 review)', async () => {
    const first = useViewerStore.getState().models.get(MODEL_ID)!;
    const firstView = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    const second = { ...first, id: 'structural', name: 'Structural' };
    const secondView = new MutablePropertyView(second.ifcDataStore!.properties, second.id);
    act(() => {
      useViewerStore.setState({
        models: new Map([[first.id, first], [second.id, second]]),
        mutationViews: new Map([[first.id, firstView], [second.id, secondView]]),
      });
    });
    const ui = await mount();
    const name = field(rows(ui)[1], 'name');
    edit(name, '   ');
    press(name, 'Enter');
    assert.ok(rows(ui)[1].querySelector('[role="alert"]'), 'refused in the first model');
    act(() => {
      useViewerStore.getState().exitModelWorkspace();
      useViewerStore.getState().enterModelWorkspace({ modelId: second.id, storeyId: STOREY });
    });
    await waitFor(() => rows(ui).length > 0, 'the second model\'s rows load');
    assert.equal(ui.querySelector('[data-storey-row] [role="alert"]'), null, 'the second model never refused anything');
  });

  it('asks what to do with the elements of a storey that holds some', async () => {
    const wall = useViewerStore.getState().addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    const ui = await mount();
    const remove = rows(ui)[0].querySelector<HTMLButtonElement>('button[aria-label^="Delete"]')!;
    act(() => click(remove));
    const panel = ui.querySelector('[data-storey-delete-panel]');
    assert.ok(panel, 'choices, not a silent delete');
    assert.match(panel!.textContent ?? '', /holds 1 element/);
    const move = [...panel!.querySelectorAll('button')].find((b) => b.textContent === 'Move and delete')!;
    act(() => click(move));
    await waitFor(() => rows(ui).length === 1, 'the storey is gone');
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    assert.equal(view.isDeleted(wall.expressId), false, 'the wall was kept, on the other storey');
  });
});
