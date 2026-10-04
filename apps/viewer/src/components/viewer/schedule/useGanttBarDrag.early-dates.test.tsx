/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6803: an early-only task (EarlyStart/EarlyFinish, no planned dates) draws
 * a bar, so it must drag. The drop writes the shifted window as planned
 * ScheduleStart/ScheduleFinish; undo restores the untouched early dates.
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useGanttBarDrag } from './useGanttBarDrag.js';

const DAY = 86_400_000;
const start = Date.parse('2010-09-20T00:00:00Z');
const earlyTime = { earlyStart: '2010-09-20T08:00:00', earlyFinish: '2010-09-20T16:00:00' };
const task: ScheduleTaskInfo = {
  expressId: 1, globalId: 'task-1', name: 'Wall #1', isMilestone: false,
  childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
  controllingScheduleGlobalIds: [], taskTime: { ...earlyTime },
};
const data: ScheduleExtraction = { tasks: [task], workSchedules: [], sequences: [], hasSchedule: true };
const originalState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(originalState, true);
});

function Harness() {
  // 300px over 3 days: 100px is one day.
  const drag = useGanttBarDrag({ range: { start, end: start + 3 * DAY, synthetic: false }, pixelWidth: 300, scale: 'day' });
  return <svg><rect data-testid="task-bar" onPointerDown={(event) => drag.onPointerDown(event, 'task-1', 'shift')} /></svg>;
}

it('#6803 dragging an early-only bar writes the shifted window as planned dates', () => {
  useViewerStore.setState({ scheduleData: data, scheduleUndoStack: [], scheduleRedoStack: [],
    scheduleTransaction: { active: false, label: '', pushedAt: -1 } });
  const ui = render(<Harness />);
  const bar = ui.querySelector('[data-testid="task-bar"]');
  assert.ok(bar);
  act(() => { bar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100 })); });
  assert.equal(useViewerStore.getState().scheduleTransaction.active, true, 'an early-only bar starts a drag');
  act(() => { window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200 })); });
  act(() => { window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 200 })); });

  const tt = useViewerStore.getState().scheduleData!.tasks[0].taskTime!;
  assert.equal(tt.scheduleStart, '2010-09-21T08:00:00');
  assert.equal(tt.scheduleFinish, '2010-09-21T16:00:00');
  assert.equal(tt.earlyStart, earlyTime.earlyStart, 'the CPM dates are kept');

  useViewerStore.getState().undoScheduleEdit();
  assert.deepEqual(useViewerStore.getState().scheduleData!.tasks[0].taskTime, earlyTime);
});
