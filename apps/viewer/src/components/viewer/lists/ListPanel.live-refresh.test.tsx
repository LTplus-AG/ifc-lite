/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9296 (modelling parity, schedules row): a wall schedule left open beside
 * the model did not follow an edit. The inspector's wall Length was read-only,
 * and an edit made any other way left the group and footer totals showing the
 * old numbers until the list was run again by hand.
 *
 * Real parsed store, real session walls, the real Lists panel and Model
 * inspector side by side; the totals are read off the rendered table.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcTypeEnum } from '@ifc-lite/data';
import type { ListDefinition } from '@ifc-lite/lists';
import { blur, cleanup, click, render, type, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { configureMutationView } from '@/utils/configureMutationView';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { ModelInspectorPanel } from '../model-inspector/ModelInspectorPanel.js';
import { ListPanel } from './ListPanel.js';

const s = () => useViewerStore.getState();

const definition: ListDefinition = {
  id: 'wall-lengths', name: 'Wall lengths', createdAt: 0, updatedAt: 0,
  entityTypes: [IfcTypeEnum.IfcWall], groups: [],
  columns: [
    { id: 'name', source: 'attribute', propertyName: 'Name' },
    { id: 'class', source: 'attribute', propertyName: 'Class' },
    { id: 'length', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Length' },
  ],
  grouping: { columnId: 'class', columnIds: ['class'], sumColumnIds: ['length'], view: 'nested' },
};

/** The Length total the table shows in its footer: what a person reads, not the stored rows. */
function footerLength(ui: HTMLElement): number {
  const footer = [...ui.querySelectorAll('div.sticky')].find((el) => /^Total\s*·/.test(el.textContent ?? ''));
  assert.ok(footer, 'the results table shows a Total footer');
  const sums = [...footer.querySelectorAll('.font-mono')].map((el) => Number((el.textContent ?? '').replace(/[^\d.-]/g, '')));
  assert.equal(sums.length, 1, 'one summed column');
  return sums[0];
}

/** The Length sum each group header shows. */
function groupLengths(ui: HTMLElement): number[] {
  return [...ui.querySelectorAll('button[aria-expanded]')]
    .map((toggle) => toggle.parentElement?.querySelector('.font-mono')?.textContent)
    .filter((text): text is string => typeof text === 'string')
    .map((text) => Number(text.replace(/[^\d.-]/g, '')));
}

const input = (root: HTMLElement, label: string) => {
  const found = [...root.querySelectorAll('input')].find((el) => el.getAttribute('aria-label') === label);
  assert.ok(found, `an input labelled "${label}"`);
  return found as HTMLInputElement;
};

let wall = 0;
let restoreRemesh: () => void;
let restoreLayout: () => void;
const initial = useViewerStore.getState();

beforeEach(async () => {
  restoreLayout = installLayout();
  const view = await seedModelingSession();
  configureMutationView(view, s().models.get(MODEL_ID)!.ifcDataStore!);
  restoreRemesh = setRequestRemesh(() => {});
  const add = (y: number, name: string) => {
    const added = s().addWall(MODEL_ID, STOREY, { Start: [0, y, 0], End: [5, y, 0], Thickness: 0.2, Height: 3, Name: name });
    assert.ok('expressId' in added);
    return added.expressId;
  };
  wall = add(0, 'Schedule wall A');
  add(3, 'Schedule wall B');
  assert.equal(s().enterModelWorkspace(), true);
  s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, wall));
  useViewerStore.setState({ listDefinitions: [definition], activeListId: null, listResult: null, listError: null,
    listExecuting: false, pendingListDraft: null });
});

afterEach(() => {
  cleanup();
  s().exitModelWorkspace();
  restoreRemesh();
  restoreLayout();
  useViewerStore.setState(initial);
  useActivityJournal.setState({ jobs: [] });
});

async function openSchedule(): Promise<HTMLElement> {
  const ui = render(<><ListPanel /><ModelInspectorPanel /></>);
  const run = ui.querySelector<HTMLButtonElement>('button[aria-label="Run list Wall lengths"]');
  assert.ok(run, 'the library offers the list');
  click(run);
  await waitFor(() => s().listResult !== null && ui.querySelector('div.sticky') !== null, 'the schedule opens');
  return ui;
}

describe('an open wall schedule follows a length typed in the Model inspector (#9296)', () => {
  it('the two 5 m walls total 10 m in the group and the footer', async () => {
    const ui = await openSchedule();
    assert.equal(footerLength(ui), 10);
    assert.deepEqual(groupLengths(ui), [10]);
  });

  it('typing 6 m moves the wall\'s end along its axis in one undo step, and the totals read 11 m', async () => {
    const ui = await openSchedule();
    const length = input(ui, 'Length in metres');
    assert.equal(length.readOnly, false, 'a wall\'s Length is editable');
    const depth = s().undoStacks.get(MODEL_ID)?.length ?? 0;
    type(length, '6');
    blur(length);

    const ends = s().readWallEndpoints(MODEL_ID, wall)!;
    assert.deepEqual(ends.start.map((v) => +v.toFixed(6)), [0, 0, 0], 'the start stays');
    assert.deepEqual(ends.end.map((v) => +v.toFixed(6)), [6, 0, 0], 'the end moves along the axis');
    assert.equal(input(ui, 'Length in metres').value, '6.00');
    const steps = new Set((s().undoStacks.get(MODEL_ID) ?? []).slice(depth).map((m) => s().mutationBatchTags.get(m.id)));
    assert.equal(steps.size, 1, 'one undo step');

    await waitFor(() => footerLength(ui) === 11, 'the footer total follows the edit');
    assert.deepEqual(groupLengths(ui), [11]);
    assert.equal(useActivityJournal.getState().jobs.length, 1, 'a refresh adds no Activity row of its own');

    act(() => s().undo(MODEL_ID));
    assert.equal(input(ui, 'Length in metres').value, '5.00');
    await waitFor(() => footerLength(ui) === 10, 'and follows the undo back');
  });
});
