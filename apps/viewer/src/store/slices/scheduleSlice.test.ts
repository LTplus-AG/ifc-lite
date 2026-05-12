/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { create } from 'zustand';
import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import {
  computeScheduleRange,
  computeHiddenProductIds,
  computeActiveProductIds,
  countGeneratedTasks,
  taskStartEpoch,
  taskFinishEpoch,
} from './scheduleSlice.js';
import { createScheduleSlice, type ScheduleSlice } from './scheduleSlice.js';

function makeExtraction(): ScheduleExtraction {
  return {
    hasSchedule: true,
    workSchedules: [],
    sequences: [],
    tasks: [
      {
        expressId: 20,
        globalId: 'task-a',
        name: 'Foundations',
        isMilestone: false,
        childGlobalIds: [],
        productExpressIds: [1, 2],
        productGlobalIds: ['w1', 'w2'],
        controllingScheduleGlobalIds: [],
        taskTime: {
          scheduleStart: '2024-01-01T00:00:00Z',
          scheduleFinish: '2024-01-11T00:00:00Z',
        },
      },
      {
        expressId: 21,
        globalId: 'task-b',
        name: 'Framing',
        isMilestone: false,
        childGlobalIds: [],
        productExpressIds: [3, 4],
        productGlobalIds: ['w3', 'w4'],
        controllingScheduleGlobalIds: [],
        taskTime: {
          scheduleStart: '2024-01-15T00:00:00Z',
          scheduleFinish: '2024-01-25T00:00:00Z',
        },
      },
      {
        // No task time — never hides its products.
        expressId: 22,
        globalId: 'task-c',
        name: 'Sitework (no time)',
        isMilestone: false,
        childGlobalIds: [],
        productExpressIds: [5],
        productGlobalIds: ['w5'],
        controllingScheduleGlobalIds: [],
      },
    ],
  };
}

describe('computeScheduleRange', () => {
  it('returns null for null data', () => {
    assert.strictEqual(computeScheduleRange(null), null);
  });

  it('returns null for an extraction with no tasks', () => {
    assert.strictEqual(
      computeScheduleRange({ hasSchedule: false, workSchedules: [], sequences: [], tasks: [] }),
      null,
    );
  });

  it('spans the earliest start and latest finish', () => {
    const range = computeScheduleRange(makeExtraction());
    assert.strictEqual(range?.synthetic, false);
    assert.strictEqual(range?.start, Date.parse('2024-01-01T00:00:00Z'));
    assert.strictEqual(range?.end, Date.parse('2024-01-25T00:00:00Z'));
  });

  it('falls back to a synthetic range when no task has dates', () => {
    const range = computeScheduleRange({
      hasSchedule: true,
      workSchedules: [],
      sequences: [],
      tasks: [{
        expressId: 1, globalId: 'x', name: 'x', isMilestone: false,
        childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
        controllingScheduleGlobalIds: [],
      }],
    });
    assert.strictEqual(range?.synthetic, true);
    assert.ok(range!.end > range!.start);
  });
});

describe('computeHiddenProductIds', () => {
  const data = makeExtraction();
  const beforeStart = Date.parse('2023-12-30T00:00:00Z');
  const duringA = Date.parse('2024-01-05T00:00:00Z');
  const duringB = Date.parse('2024-01-20T00:00:00Z');
  const afterAll = Date.parse('2024-02-01T00:00:00Z');

  it('hides all task-bound products before any task starts', () => {
    const hidden = computeHiddenProductIds(data, beforeStart);
    assert.strictEqual(hidden.has(1), true);
    assert.strictEqual(hidden.has(2), true);
    assert.strictEqual(hidden.has(3), true);
    assert.strictEqual(hidden.has(4), true);
  });

  it('reveals products whose task has started', () => {
    const hidden = computeHiddenProductIds(data, duringA);
    assert.strictEqual(hidden.has(1), false);
    assert.strictEqual(hidden.has(2), false);
    assert.strictEqual(hidden.has(3), true);
    assert.strictEqual(hidden.has(4), true);
  });

  it('reveals later tasks once time advances', () => {
    const hidden = computeHiddenProductIds(data, duringB);
    assert.strictEqual(hidden.has(3), false);
    assert.strictEqual(hidden.has(4), false);
  });

  it('never hides products whose task has no scheduled time', () => {
    const hidden = computeHiddenProductIds(data, beforeStart);
    assert.strictEqual(hidden.has(5), false);
  });

  it('reveals everything after schedule completes', () => {
    const hidden = computeHiddenProductIds(data, afterAll);
    assert.strictEqual(hidden.size, 0);
  });

  it('schedule filter: only tasks controlled by the active schedule contribute', () => {
    const filtered = {
      hasSchedule: true,
      workSchedules: [],
      sequences: [],
      tasks: [
        {
          expressId: 20, globalId: 'task-a', name: 'A', isMilestone: false,
          childGlobalIds: [], productExpressIds: [1], productGlobalIds: ['w1'],
          controllingScheduleGlobalIds: ['sched-A'],
          taskTime: { scheduleStart: '2024-01-01T00:00:00Z', scheduleFinish: '2024-01-05T00:00:00Z' },
        },
        {
          expressId: 21, globalId: 'task-b', name: 'B', isMilestone: false,
          childGlobalIds: [], productExpressIds: [2], productGlobalIds: ['w2'],
          controllingScheduleGlobalIds: ['sched-B'],
          taskTime: { scheduleStart: '2024-01-10T00:00:00Z', scheduleFinish: '2024-01-15T00:00:00Z' },
        },
      ],
    };
    // Before any task starts — schedule A filter hides only A's products.
    const hiddenA = computeHiddenProductIds(filtered, Date.parse('2023-12-30T00:00:00Z'), 'sched-A');
    assert.strictEqual(hiddenA.has(1), true);
    assert.strictEqual(hiddenA.has(2), false, 'task-b is out of scope for sched-A');

    // Empty / null filter falls back to "all tasks in scope".
    const hiddenAll = computeHiddenProductIds(filtered, Date.parse('2023-12-30T00:00:00Z'));
    assert.strictEqual(hiddenAll.has(1), true);
    assert.strictEqual(hiddenAll.has(2), true);
  });

  it('schedule filter: tasks with no controllingScheduleGlobalIds are always in-scope', () => {
    const unattached = {
      hasSchedule: true,
      workSchedules: [],
      sequences: [],
      tasks: [{
        expressId: 20, globalId: 'task', name: 'orphan', isMilestone: false,
        childGlobalIds: [], productExpressIds: [9], productGlobalIds: ['w9'],
        controllingScheduleGlobalIds: [], // no controlling schedule
        taskTime: { scheduleStart: '2024-01-01T00:00:00Z', scheduleFinish: '2024-01-05T00:00:00Z' },
      }],
    };
    const hidden = computeHiddenProductIds(unattached, Date.parse('2023-12-30T00:00:00Z'), 'sched-A');
    assert.strictEqual(hidden.has(9), true, 'orphan task still contributes when filter is applied');
  });
});

describe('computeActiveProductIds', () => {
  const data = makeExtraction();
  it('marks products as active during their task window', () => {
    const active = computeActiveProductIds(data, Date.parse('2024-01-05T00:00:00Z'));
    assert.strictEqual(active.has(1), true);
    assert.strictEqual(active.has(2), true);
    assert.strictEqual(active.has(3), false);
  });

  it('returns empty when between tasks', () => {
    const active = computeActiveProductIds(data, Date.parse('2024-01-13T00:00:00Z'));
    assert.strictEqual(active.size, 0);
  });
});

describe('task time helpers', () => {
  it('computes finish from duration when ScheduleFinish is missing', () => {
    const task = {
      expressId: 1, globalId: 'x', name: 'x', isMilestone: false,
      childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
      controllingScheduleGlobalIds: [],
      taskTime: { scheduleStart: '2024-01-01T00:00:00Z', scheduleDuration: 'P5D' },
    };
    assert.strictEqual(taskStartEpoch(task), Date.parse('2024-01-01T00:00:00Z'));
    assert.strictEqual(taskFinishEpoch(task), Date.parse('2024-01-06T00:00:00Z'));
  });
});

describe('countGeneratedTasks', () => {
  const mkTask = (expressId: number | undefined, globalId: string) => ({
    expressId: expressId as number,
    globalId,
    name: globalId,
    isMilestone: false,
    childGlobalIds: [],
    productExpressIds: [],
    productGlobalIds: [],
    controllingScheduleGlobalIds: [],
  });

  it('returns 0 for null / empty data', () => {
    assert.strictEqual(countGeneratedTasks(null), 0);
    assert.strictEqual(countGeneratedTasks(undefined), 0);
    assert.strictEqual(countGeneratedTasks({
      hasSchedule: false, workSchedules: [], sequences: [], tasks: [],
    }), 0);
  });

  it('counts only tasks with expressId <= 0 or missing', () => {
    const data: ScheduleExtraction = {
      hasSchedule: true, workSchedules: [], sequences: [],
      tasks: [
        mkTask(42, 'parsed'),     // extracted — already in STEP
        mkTask(0, 'generated-a'),  // generated
        mkTask(undefined, 'generated-b'), // generated (missing id)
        mkTask(100, 'parsed-2'),   // extracted
      ],
    };
    assert.strictEqual(countGeneratedTasks(data), 2);
  });

  it('agrees with the export partitioning rule (no tasks with expressId>0 counted)', () => {
    // Regression guard: if injectScheduleIntoStep's filter ever diverges from
    // this helper, the badge count and the actual injected set get out of
    // sync. Keep them lockstep.
    const data: ScheduleExtraction = {
      hasSchedule: true, workSchedules: [], sequences: [],
      tasks: [
        mkTask(1, 'a'), mkTask(2, 'b'), mkTask(3, 'c'),
      ],
    };
    assert.strictEqual(countGeneratedTasks(data), 0);
  });
});

// ─── editing (P1) ──────────────────────────────────────────────────────

/**
 * Boot a bare scheduleSlice in a test-only zustand store. We don't need
 * the other slices for mutator tests — the cross-slice dirty/version
 * fields are referenced defensively via `as unknown as` casts so they
 * simply no-op when absent, and that's fine for our assertions.
 */
function bootScheduleStore() {
  return create<ScheduleSlice>()((set, get, api) => createScheduleSlice(set, get, api));
}

function mkTask(over: Partial<ScheduleTaskInfo> & { globalId: string }): ScheduleTaskInfo {
  const defaults = {
    expressId: 1,
    name: `T-${over.globalId}`,
    isMilestone: false,
    childGlobalIds: [],
    productExpressIds: [],
    productGlobalIds: [],
    controllingScheduleGlobalIds: [],
  };
  // Spread `over` LAST so callers win every contested field (including globalId).
  return { ...defaults, ...over };
}

function mkExtraction(tasks: ScheduleTaskInfo[]): ScheduleExtraction {
  return { hasSchedule: true, workSchedules: [], sequences: [], tasks };
}

describe('scheduleSlice editing — updateTask', () => {
  it('patches name / predefinedType without touching unrelated fields', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({ globalId: 'a', name: 'Old', predefinedType: 'CONSTRUCTION', identification: 'IDENT' }),
    ]));
    store.getState().updateTask('a', { name: 'New', predefinedType: 'INSTALLATION' });

    const t = store.getState().scheduleData!.tasks[0];
    assert.strictEqual(t.name, 'New');
    assert.strictEqual(t.predefinedType, 'INSTALLATION');
    assert.strictEqual(t.identification, 'IDENT');
    assert.strictEqual(store.getState().scheduleIsEdited, true);
  });

  it('isMilestone → true collapses duration and finish', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({
        globalId: 'm', isMilestone: false,
        taskTime: {
          scheduleStart: '2024-05-01T08:00:00',
          scheduleFinish: '2024-05-05T08:00:00',
          scheduleDuration: 'P4D',
        },
      }),
    ]));
    store.getState().updateTask('m', { isMilestone: true });
    const t = store.getState().scheduleData!.tasks[0];
    assert.strictEqual(t.isMilestone, true);
    assert.strictEqual(t.taskTime?.scheduleDuration, 'PT0S');
    assert.strictEqual(t.taskTime?.scheduleFinish, '2024-05-01T08:00:00');
  });
});

describe('scheduleSlice editing — updateTaskTime', () => {
  it('start + finish → derived duration (days)', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({ globalId: 'a', taskTime: { scheduleStart: '2024-05-01T08:00:00' } }),
    ]));
    store.getState().updateTaskTime('a', {
      scheduleStart: '2024-05-01T08:00:00',
      scheduleFinish: '2024-05-06T08:00:00',
    });
    const t = store.getState().scheduleData!.tasks[0];
    assert.strictEqual(t.taskTime?.scheduleDuration, 'P5D');
  });

  it('start + duration → derived finish', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({ globalId: 'a' }),
    ]));
    store.getState().updateTaskTime('a', {
      scheduleStart: '2024-05-01T08:00:00',
      scheduleDuration: 'P5D',
    });
    const t = store.getState().scheduleData!.tasks[0];
    assert.strictEqual(t.taskTime?.scheduleFinish, '2024-05-06T08:00:00');
  });

  it('rejects finish-before-start (no mutation)', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({
        globalId: 'a',
        taskTime: {
          scheduleStart: '2024-05-05T08:00:00',
          scheduleFinish: '2024-05-10T08:00:00',
        },
      }),
    ]));
    store.getState().updateTaskTime('a', { scheduleFinish: '2024-05-01T08:00:00' });
    // Value unchanged.
    const t = store.getState().scheduleData!.tasks[0];
    assert.strictEqual(t.taskTime?.scheduleFinish, '2024-05-10T08:00:00');
  });
});

describe('scheduleSlice editing — assign / unassign products', () => {
  it('assign appends + dedupes', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({ globalId: 'a', productExpressIds: [1], productGlobalIds: ['1'] }),
    ]));
    store.getState().assignProductsToTask('a', [1, 2, 3]);
    const t = store.getState().scheduleData!.tasks[0];
    assert.deepStrictEqual(t.productExpressIds.sort(), [1, 2, 3]);
    // Calling again with same set is idempotent.
    store.getState().assignProductsToTask('a', [2, 3]);
    assert.deepStrictEqual(
      store.getState().scheduleData!.tasks[0].productExpressIds.sort(),
      [1, 2, 3],
    );
  });

  it('unassign drops targeted ids only', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({
        globalId: 'a',
        productExpressIds: [1, 2, 3],
        productGlobalIds: ['1', '2', '3'],
      }),
    ]));
    store.getState().unassignProductsFromTask('a', [2]);
    const t = store.getState().scheduleData!.tasks[0];
    assert.deepStrictEqual(t.productExpressIds, [1, 3]);
    assert.deepStrictEqual(t.productGlobalIds, ['1', '3']);
  });
});

describe('scheduleSlice editing — deleteTask', () => {
  it('removes the task and cascades sequences referring to it', () => {
    const store = bootScheduleStore();
    const data: ScheduleExtraction = {
      hasSchedule: true, workSchedules: [], tasks: [
        mkTask({ globalId: 'a' }),
        mkTask({ globalId: 'b' }),
      ],
      sequences: [
        { globalId: 'seq-ab', relatingTaskGlobalId: 'a', relatedTaskGlobalId: 'b', sequenceType: 'FINISH_START' },
      ],
    };
    store.getState().setScheduleData(data);
    store.getState().deleteTask('a');
    const s = store.getState().scheduleData!;
    assert.strictEqual(s.tasks.length, 1);
    assert.strictEqual(s.tasks[0].globalId, 'b');
    assert.strictEqual(s.sequences.length, 0);
    assert.strictEqual(store.getState().scheduleIsEdited, true);
  });

  it('cascades into descendant tasks', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData({
      hasSchedule: true, workSchedules: [], sequences: [],
      tasks: [
        mkTask({ globalId: 'parent', childGlobalIds: ['child1', 'child2'] }),
        mkTask({ globalId: 'child1', parentGlobalId: 'parent' }),
        mkTask({ globalId: 'child2', parentGlobalId: 'parent', childGlobalIds: ['grand'] }),
        mkTask({ globalId: 'grand', parentGlobalId: 'child2' }),
        mkTask({ globalId: 'unrelated' }),
      ],
    });
    store.getState().deleteTask('parent');
    const s = store.getState().scheduleData!;
    const remaining = s.tasks.map(t => t.globalId).sort();
    assert.deepStrictEqual(remaining, ['unrelated']);
  });
});

describe('scheduleSlice editing — undo / redo', () => {
  it('undo restores pre-edit state; redo reapplies', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({ globalId: 'a', name: 'Original' }),
    ]));
    store.getState().updateTask('a', { name: 'Changed' });
    assert.strictEqual(store.getState().scheduleData!.tasks[0].name, 'Changed');

    store.getState().undoScheduleEdit();
    assert.strictEqual(store.getState().scheduleData!.tasks[0].name, 'Original');
    assert.strictEqual(store.getState().scheduleIsEdited, false);

    store.getState().redoScheduleEdit();
    assert.strictEqual(store.getState().scheduleData!.tasks[0].name, 'Changed');
    assert.strictEqual(store.getState().scheduleIsEdited, true);
  });

  it('transactions coalesce rapid edits into a single undo step', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({
        globalId: 'a',
        taskTime: {
          scheduleStart: '2024-05-01T08:00:00',
          scheduleFinish: '2024-05-02T08:00:00',
        },
      }),
    ]));
    store.getState().beginScheduleTransaction('drag');
    store.getState().updateTaskTime('a', { scheduleStart: '2024-05-01T09:00:00' });
    store.getState().updateTaskTime('a', { scheduleStart: '2024-05-01T10:00:00' });
    store.getState().updateTaskTime('a', { scheduleStart: '2024-05-01T12:00:00' });
    store.getState().endScheduleTransaction();
    assert.strictEqual(store.getState().scheduleUndoStack.length, 1);
    store.getState().undoScheduleEdit();
    assert.strictEqual(
      store.getState().scheduleData!.tasks[0].taskTime?.scheduleStart,
      '2024-05-01T08:00:00',
    );
  });

  it('transaction state is store-scoped — two stores do not alias', () => {
    // Regression: transaction state used to live at module scope, which
    // meant a transaction opened on one store leaked into a second store
    // instantiated in the same process (tests, multi-session, hot-reload).
    // Now that state lives inside the slice, each store owns its own window.
    const storeA = bootScheduleStore();
    const storeB = bootScheduleStore();
    storeA.getState().setScheduleData(mkExtraction([
      mkTask({
        globalId: 'a',
        taskTime: {
          scheduleStart: '2024-05-01T08:00:00',
          scheduleFinish: '2024-05-02T08:00:00',
        },
      }),
    ]));
    storeB.getState().setScheduleData(mkExtraction([
      mkTask({
        globalId: 'b',
        taskTime: {
          scheduleStart: '2024-05-01T08:00:00',
          scheduleFinish: '2024-05-02T08:00:00',
        },
      }),
    ]));

    // Open a transaction on A. B should see a clean transaction state.
    storeA.getState().beginScheduleTransaction('drag');
    assert.strictEqual(storeA.getState().scheduleTransaction.active, true);
    assert.strictEqual(storeB.getState().scheduleTransaction.active, false);

    // Edits on B should produce independent undo entries — not suppressed
    // by A's open transaction.
    storeB.getState().updateTaskTime('b', { scheduleStart: '2024-05-01T09:00:00' });
    storeB.getState().updateTaskTime('b', { scheduleStart: '2024-05-01T10:00:00' });
    // Each edit on B gets its own snapshot (2 total) because B is not in
    // a transaction. If the module-level global were still here, A's
    // transaction would suppress B's snapshots and we'd see 0.
    assert.strictEqual(storeB.getState().scheduleUndoStack.length, 2);

    storeA.getState().endScheduleTransaction();
    assert.strictEqual(storeA.getState().scheduleTransaction.active, false);
  });

  // ── P1.4 — operation-based undo replay symmetry ─────────────────────

  it('undo → redo → undo is byte-identical on field edits', () => {
    // Property test — after N undos + N redos + N undos the state must
    // equal the state after the first N undos, byte-for-byte. Proves the
    // field-patch descriptor's inverse-capture keeps undo/redo symmetric.
    // If this breaks, users lose edits on second-undo after a redo.
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({
        globalId: 'a', name: 'A0', identification: 'id0',
        taskTime: {
          scheduleStart: '2024-05-01T08:00:00',
          scheduleFinish: '2024-05-02T08:00:00',
        },
      }),
    ]));
    store.getState().updateTask('a', { name: 'A1' });
    store.getState().updateTaskTime('a', { scheduleStart: '2024-05-01T12:00:00' });

    store.getState().undoScheduleEdit();
    store.getState().undoScheduleEdit();
    const afterUndos = JSON.stringify(store.getState().scheduleData);
    assert.strictEqual(store.getState().scheduleIsEdited, false);

    store.getState().redoScheduleEdit();
    store.getState().redoScheduleEdit();
    assert.strictEqual(store.getState().scheduleData!.tasks[0].name, 'A1');
    assert.strictEqual(store.getState().scheduleIsEdited, true);

    store.getState().undoScheduleEdit();
    store.getState().undoScheduleEdit();
    assert.strictEqual(
      JSON.stringify(store.getState().scheduleData),
      afterUndos,
      'second undo pass must be byte-identical to the first',
    );
  });

  it('updateTaskTime rejects finish < start without pushing a snapshot', () => {
    // Rejection is silent but MUST leave the stack unchanged, otherwise
    // the user sees a redo-empty undo chip even though nothing committed.
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({
        globalId: 'a',
        taskTime: {
          scheduleStart: '2024-05-01T08:00:00',
          scheduleFinish: '2024-05-02T08:00:00',
        },
      }),
    ]));
    store.getState().updateTaskTime('a', { scheduleFinish: '2024-04-01T00:00:00' });
    assert.strictEqual(store.getState().scheduleUndoStack.length, 0);
    assert.strictEqual(
      store.getState().scheduleData!.tasks[0].taskTime?.scheduleFinish,
      '2024-05-02T08:00:00',
    );
  });
});

describe('scheduleSlice editing — addTask', () => {
  it('appends at the end when no predecessor is given', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({ globalId: 'a', name: 'A' }),
      mkTask({ globalId: 'b', name: 'B' }),
    ]));
    const newGid = store.getState().addTask();
    const s = store.getState().scheduleData!;
    assert.strictEqual(s.tasks.length, 3);
    assert.strictEqual(s.tasks[2].globalId, newGid);
  });

  it('inserts after the given predecessor', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({ globalId: 'a', name: 'A' }),
      mkTask({ globalId: 'b', name: 'B' }),
      mkTask({ globalId: 'c', name: 'C' }),
    ]));
    const newGid = store.getState().addTask({ afterGlobalId: 'a' });
    const names = store.getState().scheduleData!.tasks.map(t => t.globalId);
    assert.deepStrictEqual(names, ['a', newGid, 'b', 'c']);
  });

  it('auto-selects the new task for immediate rename', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([mkTask({ globalId: 'a' })]));
    const newGid = store.getState().addTask();
    const sel = Array.from(store.getState().selectedTaskGlobalIds);
    assert.deepStrictEqual(sel, [newGid]);
  });

  it('flips scheduleIsEdited so the export badge lights up', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([mkTask({ globalId: 'a' })]));
    store.getState().addTask();
    assert.strictEqual(store.getState().scheduleIsEdited, true);
  });

  it('synthesises a work schedule when none exists', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData({
      hasSchedule: true, workSchedules: [], sequences: [], tasks: [],
    });
    store.getState().addTask();
    const s = store.getState().scheduleData!;
    assert.strictEqual(s.workSchedules.length, 1);
    assert.strictEqual(s.workSchedules[0].taskGlobalIds.length, 1);
    assert.strictEqual(s.workSchedules[0].taskGlobalIds[0], s.tasks[0].globalId);
  });
});

describe('scheduleSlice editing — moveTask', () => {
  it('moves a task to the requested index', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({ globalId: 'a' }),
      mkTask({ globalId: 'b' }),
      mkTask({ globalId: 'c' }),
      mkTask({ globalId: 'd' }),
    ]));
    store.getState().moveTask('a', 2);
    const order = store.getState().scheduleData!.tasks.map(t => t.globalId);
    assert.deepStrictEqual(order, ['b', 'c', 'a', 'd']);
  });

  it('moves backwards too (larger index to smaller)', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData(mkExtraction([
      mkTask({ globalId: 'a' }),
      mkTask({ globalId: 'b' }),
      mkTask({ globalId: 'c' }),
    ]));
    store.getState().moveTask('c', 0);
    const order = store.getState().scheduleData!.tasks.map(t => t.globalId);
    assert.deepStrictEqual(order, ['c', 'a', 'b']);
  });

  it('reflects move in the work schedule taskGlobalIds', () => {
    const store = bootScheduleStore();
    store.getState().setScheduleData({
      hasSchedule: true, sequences: [],
      workSchedules: [{
        expressId: 0, globalId: 'ws', kind: 'WorkSchedule', name: 'WS',
        taskGlobalIds: ['a', 'b', 'c'],
      }],
      tasks: [
        mkTask({ globalId: 'a' }),
        mkTask({ globalId: 'b' }),
        mkTask({ globalId: 'c' }),
      ],
    });
    store.getState().moveTask('c', 0);
    assert.deepStrictEqual(
      store.getState().scheduleData!.workSchedules[0].taskGlobalIds,
      ['c', 'a', 'b'],
    );
  });
});
