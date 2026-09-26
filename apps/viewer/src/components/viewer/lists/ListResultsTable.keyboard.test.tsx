/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { ProjectUnits } from '@ifc-lite/parser';
import type { ListResult, ListGrouping } from '@ifc-lite/lists';
import { installLayout } from '@/test/dom-layout.js';
import { activate, advance, click, cleanup, mouseDown, press, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ListResultsTable } from './ListResultsTable.js';

const result: ListResult = {
  columns: [
    { id: 'name', source: 'attribute', propertyName: 'Name', label: 'Name' },
    { id: 'volume', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume', label: 'Volume' },
  ],
  rows: [
    { entityId: 1, modelId: 'default', values: ['Wall A', 10] },
    { entityId: 2, modelId: 'default', values: ['Wall B', 20] },
  ],
  totalCount: 2,
  executionTime: 4,
};
const grouping: ListGrouping = { columnId: 'name', columnIds: ['name'], sumColumnIds: ['volume'], view: 'nested' };
const modelUnits = new Map([['default', ProjectUnits.empty()]]);
let restoreLayout: () => void;
let initialState: ReturnType<typeof useViewerStore.getState>;

beforeEach(() => {
  initialState = useViewerStore.getState();
  restoreLayout = installLayout();
});
afterEach(() => {
  cleanup();
  restoreLayout();
  useViewerStore.setState(initialState, true);
});

it('#5823 keyboard opens grouped list rows', async () => {
  const ui = render(<ListResultsTable result={result} grouping={grouping} modelUnits={modelUnits} />);
  click(ui.querySelector('button[aria-label="Showing visible objects only"]')!);
  await advance(5);

  const group = ui.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
  assert.ok(group, 'a collapsed group must be rendered');
  activate(group, 'Enter');
  assert.equal(group.getAttribute('aria-expanded'), 'true');

  activate(group, ' ');
  assert.equal(group.getAttribute('aria-expanded'), 'false');
});

it('#5823 keyboard selects a result member', async () => {
  const ui = render(<ListResultsTable result={result} modelUnits={modelUnits} />);
  click(ui.querySelector('button[aria-label="Showing visible objects only"]')!);
  await advance(5);
  const member = [...ui.querySelectorAll<HTMLButtonElement>('button.absolute[aria-pressed]')]
    .find((button) => button.textContent?.includes('Wall A'));
  assert.ok(member, 'a result member must be rendered');
  activate(member, ' ');
  assert.equal(member.getAttribute('aria-pressed'), 'true');
  assert.ok(useViewerStore.getState().selectedEntityIds.has(1));
});

it('#5823 list resize grips adjust and reset widths from the keyboard', () => {
  const ui = render(<ListResultsTable result={result} modelUnits={modelUnits} />);
  const grip = ui.querySelector('button[aria-label*="arrow keys to adjust"]') as HTMLButtonElement;
  assert.ok(grip);
  assert.match(grip.getAttribute('aria-label') ?? '', /Name/);
  const header = grip.parentElement as HTMLElement;
  const initialWidth = Number.parseFloat(header.style.width);
  press(grip, 'ArrowRight');
  assert.equal(Number.parseFloat(header.style.width), initialWidth + 10);
  press(grip, 'Home');
  assert.equal(Number.parseFloat(header.style.width), initialWidth);
});

it('#5823 an unlabeled list column announces its displayed property name on the resize grip', () => {
  const unlabeled: ListResult = {
    ...result,
    columns: [result.columns[0]!, { ...result.columns[1]!, label: undefined }],
  };
  const ui = render(<ListResultsTable result={unlabeled} modelUnits={modelUnits} />);
  const grip = ui.querySelectorAll<HTMLButtonElement>('button[aria-label*="arrow keys to adjust"]')[1];
  assert.ok(grip);
  assert.match(grip.getAttribute('aria-label') ?? '', /NetVolume/);
  assert.doesNotMatch(grip.getAttribute('aria-label') ?? '', /undefined/);
});

it('#5823 schedule resize grips use the same keyboard controls', () => {
  const ui = render(<ListResultsTable result={result} grouping={{ ...grouping, view: 'schedule' }} modelUnits={modelUnits} />);
  const grip = ui.querySelector('button[aria-label*="arrow keys to adjust"]') as HTMLButtonElement;
  assert.ok(grip);
  const header = grip.parentElement as HTMLElement;
  const initialWidth = Number.parseFloat(header.style.width);
  press(grip, 'ArrowRight');
  assert.equal(Number.parseFloat(header.style.width), initialWidth + 10);
  press(grip, 'Home');
  assert.equal(Number.parseFloat(header.style.width), initialWidth);
});

it('#5823 pointer dragging still resizes a column after sharing its grip', () => {
  const ui = render(<ListResultsTable result={result} modelUnits={modelUnits} />);
  const grip = ui.querySelector('button[aria-label*="arrow keys to adjust"]') as HTMLButtonElement;
  assert.ok(grip);
  const header = grip.parentElement as HTMLElement;
  const initialWidth = Number.parseFloat(header.style.width);
  mouseDown(grip, { clientX: 100 });
  act(() => {
    window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 120 }));
    window.dispatchEvent(new window.MouseEvent('mouseup'));
  });
  assert.equal(Number.parseFloat(header.style.width), initialWidth + 20);
});

it('#5823 unmounting an active resize restores document interaction', () => {
  const ui = render(<ListResultsTable result={result} modelUnits={modelUnits} />);
  const grip = ui.querySelector<HTMLButtonElement>('button[aria-label*="arrow keys to adjust"]');
  assert.ok(grip);
  const cursor = document.body.style.cursor;
  const userSelect = document.body.style.userSelect;
  mouseDown(grip, { clientX: 100 });
  assert.equal(document.body.style.userSelect, 'none');
  cleanup();
  assert.equal(document.body.style.cursor, cursor);
  assert.equal(document.body.style.userSelect, userSelect);
});
