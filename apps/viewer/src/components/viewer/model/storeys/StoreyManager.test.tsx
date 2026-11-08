/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9013: the storey manager as a person uses it. Highest first with the
 * active storey marked; add above without changing the drawing plane; inline edits
 * commit on Enter, cancel on Escape and explain a refusal next to the field;
 * an empty storey deletes straight away, one with elements asks first.
 */

import '@/test/setup-dom.js';
import '@/lib/commands/modeling/builtin';
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
import { commitStoreyOp } from '@/store/slices/mutation-storey';
import { reviewStoreyInsertion, commitStoreyInsertion } from './insert-storey';
import { PropertyValueType } from '@ifc-lite/data';
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
    assert.equal(created, UPPER_STOREY, '#9296 drawing and isolation stay on the previous storey');
    assert.equal(soloOn(created), true);
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

  it('#9296 adds a storey above without changing the active drawing plane', async () => {
    const ui = await mount();
    const add = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Add storey above'))!;
    act(() => click(add));
    await waitFor(() => rows(ui).length === 3, 'the new row appears');
    assert.deepEqual(elevations(), [0, 3, 6], '#9334 header adds above the topmost storey, preserving the lower floor height');
    const created = useViewerStore.getState().session?.storeyId;
    assert.equal(created, STOREY, '#9296 adding a level does not move the drawing plane');
    assert.equal(rows(ui)[2].querySelector('[role="radio"]')?.getAttribute('aria-checked'), 'true');
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

  it('Escape on a buried preview that cannot be put back says so (#9037 review)', async () => {
    const { StoreyManager } = await requiredModule(() => import('./StoreyManager'), 'the storey manager exists (#9013)');
    const { commitStoreyOp } = await import('@/store/slices/mutation-storey');
    const ui = render(<><StoreyManager onBack={() => {}} /><Toaster /></>);
    await waitFor(() => rows(ui).length > 0, 'the rows load');
    const elevation = field(rows(ui)[0], 'elevation');
    edit(elevation, '3.4');
    await advance(400);
    assert.deepEqual(elevations(), [0, 3.4], 'previewing');
    // A script adds a storey at 3.2 m: putting L1 back to 3.0 m would cross it.
    act(() => { assert.ok(commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Mid', Elevation: 3.2, referenceStoreyId: STOREY } }).ok); });
    press(elevation, 'Escape');
    assert.deepEqual(elevations(), [0, 3.2, 3.4], 'the previewed elevation is still applied');
    await waitFor(() => /L1 would pass Mid/.test(document.body.textContent ?? ''), 'Escape reports that L1 could not go back');
  });

  it('typing an invalid length over a stuck buried preview still says it stays applied (#9037 review)', async () => {
    const { StoreyManager } = await requiredModule(() => import('./StoreyManager'), 'the storey manager exists (#9013)');
    const { commitStoreyOp } = await import('@/store/slices/mutation-storey');
    const ui = render(<><StoreyManager onBack={() => {}} /><Toaster /></>);
    await waitFor(() => rows(ui).length > 0, 'the rows load');
    const elevation = field(rows(ui)[0], 'elevation');
    edit(elevation, '3.4');
    await advance(400);
    // A name no other test uses: toasts are module-wide and merge identical messages.
    act(() => { assert.ok(commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Gallery', Elevation: 3.2, referenceStoreyId: STOREY } }).ok); });
    assert.equal(/L1 would pass Gallery/.test(document.body.textContent ?? ''), false);
    edit(elevation, 'three');
    await waitFor(() => /L1 would pass Gallery/.test(document.body.textContent ?? ''), 'the refused restore is reported');
    assert.deepEqual(elevations(), [0, 3.2, 3.4], 'the previewed elevation stays applied');
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
    // Undoing a wall's creation can drop it from the new entities without marking it deleted:
    // check it is still authored, and that its own step is still the newest one.
    assert.ok(view.getNewEntity(later.expressId), 'the later wall is still authored');
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

  it('a refused level edit in one model is not shown on another model\'s storey with the same id (#9037 review)', async () => {
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
    const elevation = field(rows(ui)[0], 'elevation');
    edit(elevation, '-1');
    press(elevation, 'Enter');
    assert.ok(rows(ui)[0].querySelector('[role="alert"]'), 'refused in the first model');
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

it('#9334 explicit insertion reviews the shift, preserves floor heights and undoes as one step', async () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in wall);
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!, PropertyValueType.Label);
  const ui = await mount();
  const ground = rows(ui).at(-1)!;
  const insert = ground.querySelector<HTMLButtonElement>('[aria-label="Insert storey above L0"]')!;
  const before = useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
  click(insert);
  assert.deepEqual(elevations(), [0, 3], 'review writes no history');
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0, before);
  await waitFor(() => !!ui.querySelector('[data-storey-insertion]'), 'the first-click insertion review loads');
  assert.match(ui.querySelector('[data-storey-insertion]')?.textContent ?? '', /Floor-to-floor stays 3.00 m. Storeys shifted: 1/);
  assert.match(ui.querySelector('[data-storey-insertion]')?.textContent ?? '', /Updates 1 wall top/);
  const confirm = [...ui.querySelectorAll('button')].find(b => b.textContent === 'Insert storey')!;
  click(confirm);
  await waitFor(() => rows(ui).length === 3, 'inserted floor appears');
  assert.deepEqual(elevations(), [0, 3, 6]);
  assert.equal(useViewerStore.getState().session?.storeyId, STOREY, 'drawing plane stays on L0');
  act(() => useViewerStore.getState().undo(MODEL_ID));
  assert.deepEqual(elevations(), [0, 3], 'one Undo restores both the shifted storey and the insertion');
});

it('#9334 a first-click insertion that finishes loading after session replacement does nothing', async () => {
  const ui = await mount();
  click(rows(ui).at(-1)!.querySelector('[aria-label="Insert storey above L0"]')!);
  act(() => {
    useViewerStore.getState().exitModelWorkspace();
    useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: STOREY });
  });
  await requiredModule(() => import('./StoreyInsertionPanel'), 'the clicked insertion module loads (#9334)');
  await advance(0);
  assert.equal(ui.querySelector('[data-storey-insertion]'), null, 'an abandoned click opens no review in the replacement session');
  assert.deepEqual(elevations(), [0, 3], 'an abandoned click adds nothing');
});

it('#9334 consecutive header adds use the live topmost storey and merge their toasts', async () => {
  const ui = await mount();
  const notices = render(<Toaster />);
  for (const dismiss of notices.querySelectorAll<HTMLButtonElement>('[aria-label="Dismiss notification"]')) click(dismiss);
  const add = [...ui.querySelectorAll('button')].find(b => b.textContent === 'Add storey above')!;
  click(add); click(add);
  await waitFor(() => rows(ui).length === 4, 'both new rows');
  assert.deepEqual(elevations(), [0, 3, 6, 9]);
  assert.equal([...notices.querySelectorAll('button')].filter(b => b.textContent === 'Draw on').length, 1);
  assert.equal(useViewerStore.getState().session?.storeyId, STOREY);
});

it('#9334 Draw on the already active storey re-seats the workplane', async () => {
  const ui = await mount();
  act(() => useViewerStore.getState().setWorkplane({ kind: 'storey', storeyId: STOREY, offset: 4 }));
  click(rows(ui).at(-1)!.querySelector('[role="radio"]')!);
  assert.deepEqual(useViewerStore.getState().session?.workplane, { kind: 'storey', storeyId: STOREY, offset: 0 });
});

it('#9334 the added-storey Draw on toast still activates a live drawable target', async () => {
  const ui = await mount();
  const notices = render(<Toaster />);
  for (const dismiss of notices.querySelectorAll('[aria-label="Dismiss notification"]')) click(dismiss);
  click([...ui.querySelectorAll('button')].find(button => button.textContent === 'Add storey above')!);
  await waitFor(() => rows(ui).length === 3, 'the added storey appears');
  const created = modelStoreys(useViewerStore.getState(), MODEL_ID).at(-1)!.expressId;
  click([...notices.querySelectorAll('button')].find(button => button.textContent === 'Draw on')!);
  await waitFor(() => useViewerStore.getState().session?.storeyId === created, 'the clicked action loads and activates the storey');
  assert.equal(useViewerStore.getState().session?.storeyId, created);
  assert.deepEqual(useViewerStore.getState().session?.workplane, { kind: 'storey', storeyId: created, offset: 0 });
});

for (const invalidation of ['undo', 'delete', 'reprojection'] as const) {
  it(`#9334 the added-storey Draw on toast refuses a target after ${invalidation}`, async () => {
    const ui = await mount();
    const notices = render(<Toaster />);
    for (const dismiss of notices.querySelectorAll('[aria-label="Dismiss notification"]')) click(dismiss);
    click([...ui.querySelectorAll('button')].find(button => button.textContent === 'Add storey above')!);
    await waitFor(() => rows(ui).length === 3, 'the added storey appears');
    const created = modelStoreys(useViewerStore.getState(), MODEL_ID).at(-1)!.expressId;
    const draw = [...notices.querySelectorAll('button')].find(button => button.textContent === 'Draw on')!;
    assert.ok(draw, 'the add toast offers Draw on');
    act(() => {
      const s = useViewerStore.getState();
      if (invalidation === 'undo') s.undo(MODEL_ID);
      else if (invalidation === 'delete') assert.ok(commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'delete', storeyId: created, mode: { kind: 'empty' } }).ok);
      else useViewerStore.setState({ models: new Map([...s.models].map(([id, model]) => [id, id === MODEL_ID ? { ...model, federationAlignmentStatus: 'reprojected' } : model])) });
    });
    const plane = useViewerStore.getState().session!.workplane;
    click(draw);
    await requiredModule(() => import('./storey-toast-actions'), 'the clicked toast action loads (#9334)');
    await advance(0);
    assert.equal(useViewerStore.getState().session?.storeyId, STOREY, 'a stale or undrawable target cannot become active');
    assert.equal(useViewerStore.getState().session?.workplane, plane, 'the existing drawing plane stays intact');
    assert.equal(draw.isConnected, false, 'the stale toast action dismisses itself');
  });
}

it('#9334 a refused insertion rolls back the preceding floor-height edit', () => {
  const reviewed = reviewStoreyInsertion(MODEL_ID, STOREY, index => `Level ${index}`)!;
  const depth = useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
  const result = commitStoreyInsertion(MODEL_ID, { ...reviewed, params: { ...reviewed.params, Elevation: NaN } });
  assert.equal(result.ok, false);
  assert.deepEqual(elevations(), [0, 3]);
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0, depth);
});
