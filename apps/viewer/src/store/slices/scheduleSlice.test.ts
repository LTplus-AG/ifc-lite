/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ScheduleExtraction } from '@ifc-lite/parser';
import {
  computeScheduleRange,
  computeHiddenProductIds,
  computeActiveProductIds,
  countGeneratedTasks,
  taskStartEpoch,
  taskFinishEpoch,
} from './scheduleSlice.js';

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
