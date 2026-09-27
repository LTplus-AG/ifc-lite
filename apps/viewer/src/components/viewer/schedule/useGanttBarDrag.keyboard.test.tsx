/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import { cleanup, press, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { useGanttBarDrag } from './useGanttBarDrag.js';

const DAY = 86_400_000;
const start = Date.parse('2025-01-01T00:00:00Z');
const finish = start + DAY;
const task: ScheduleTaskInfo = {
  expressId: 1, globalId: 'task-1', name: 'Task 1', isMilestone: false,
  childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
  controllingScheduleGlobalIds: [],
  taskTime: { scheduleStart: '2025-01-01T00:00:00', scheduleFinish: '2025-01-02T00:00:00' },
};
const data: ScheduleExtraction = { tasks: [task], workSchedules: [], sequences: [], hasSchedule: true };
const originalState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(originalState, true);
});

function Harness() {
  const drag = useGanttBarDrag({ range: { start, end: finish + DAY, synthetic: false }, pixelWidth: 300, scale: 'day' });
  return <svg><rect data-testid="task-bar" onPointerDown={(event) => drag.onPointerDown(event, 'task-1', 'shift')} />
    <text data-testid="live-task">{drag.live.taskGlobalId ?? 'none'}</text></svg>;
}

it('#5841 Gantt Escape aborts the active drag transaction before global Escape', () => {
  useViewerStore.setState({ scheduleData: data, scheduleUndoStack: [], scheduleRedoStack: [],
    scheduleTransaction: { active: false, label: '', pushedAt: -1 } });
  let globalEscapes = 0;
  let drawingEscapes = 0;
  const unregisterDrawing = registerKeyboardCommand('drawing2d.cancel', () => { drawingEscapes++; });
  const unregister = registerKeyboardCommand('selection.escape', () => { globalEscapes++; });
  try {
    const ui = render(<Harness />);
    const bar = ui.querySelector('[data-testid="task-bar"]');
    assert.ok(bar);
    act(() => { bar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100 })); });
    assert.equal(useViewerStore.getState().scheduleTransaction.active, true);
    assert.equal(ui.querySelector('[data-testid="live-task"]')?.textContent, 'task-1');
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200 })); });
    assert.notEqual(useViewerStore.getState().scheduleData?.tasks[0]?.taskTime?.scheduleStart, task.taskTime?.scheduleStart);

    press(window, 'Escape');
    assert.equal(globalEscapes, 0);
    assert.equal(drawingEscapes, 0, 'a persisted drawing selection cannot intercept active Gantt drag');
    assert.equal(useViewerStore.getState().scheduleTransaction.active, false);
    assert.equal(useViewerStore.getState().scheduleData?.tasks[0]?.taskTime?.scheduleStart, task.taskTime?.scheduleStart);
    assert.equal(useViewerStore.getState().scheduleUndoStack.length, 0);
    assert.equal(ui.querySelector('[data-testid="live-task"]')?.textContent, 'none');
  } finally {
    unregister();
    unregisterDrawing();
  }
});
