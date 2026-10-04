/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6803 — the canonical task-window resolver, and the readers that used to
 * carry their own diverged copy (Gantt range, 4D animator, charts).
 *
 * The early-only task mirrors buildingSMART's construction-scheduling-task
 * sample: ScheduleStart/ScheduleFinish `$`, EarlyStart/EarlyFinish set.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ScheduleExtraction, ScheduleTaskInfo, ScheduleTaskTimeInfo } from '@ifc-lite/parser';
import {
  taskStartEpoch,
  taskFinishEpoch,
  taskStartIso,
  taskFinishIso,
  taskDurationIso,
} from './schedule-task-dates.js';
import { computeScheduleRange } from './scheduleSlice.js';
import { computeAnimationFrame, DEFAULT_ANIMATION_SETTINGS } from '../../components/viewer/schedule/schedule-animator.js';
import { phaseAt } from '../../lib/charts/datasets/schedule.js';

const utc = (iso: string) => Date.parse(`${iso}Z`);

function task(taskTime: ScheduleTaskTimeInfo, over: Partial<ScheduleTaskInfo> = {}): ScheduleTaskInfo {
  return {
    expressId: 1, globalId: 't', name: 'T', isMilestone: false,
    childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
    controllingScheduleGlobalIds: [], taskTime, ...over,
  };
}

const earlyOnly = task({
  scheduleDuration: 'P0Y0M0DT8H0M0S',
  earlyStart: '2010-09-20T08:00:00',
  earlyFinish: '2010-09-20T16:00:00',
});

describe('task window resolution (#6803)', () => {
  it('uses EarlyStart/EarlyFinish when the task has no planned or actual date', () => {
    assert.equal(taskStartEpoch(earlyOnly), utc('2010-09-20T08:00:00'));
    assert.equal(taskFinishEpoch(earlyOnly), utc('2010-09-20T16:00:00'));
    assert.equal(taskStartIso(earlyOnly), '2010-09-20T08:00:00');
    assert.equal(taskFinishIso(earlyOnly), '2010-09-20T16:00:00');
    assert.equal(taskDurationIso(earlyOnly), 'P0Y0M0DT8H0M0S');
  });

  it('derives a missing EarlyFinish from EarlyStart + ScheduleDuration', () => {
    const t = task({ earlyStart: '2010-09-21T08:00:00', scheduleDuration: 'PT8H' });
    assert.equal(taskFinishEpoch(t), utc('2010-09-21T16:00:00'));
    assert.equal(taskFinishIso(t), '2010-09-21T16:00:00');
  });

  it('keeps planned dates winning over early ones', () => {
    const t = task({
      scheduleStart: '2024-05-01T08:00:00', scheduleFinish: '2024-05-03T17:00:00',
      earlyStart: '2010-01-01T00:00:00', earlyFinish: '2010-01-02T00:00:00',
    });
    assert.equal(taskStartEpoch(t), utc('2024-05-01T08:00:00'));
    assert.equal(taskFinishEpoch(t), utc('2024-05-03T17:00:00'));
  });

  it('never pairs a planned start with an early finish', () => {
    const t = task({
      scheduleStart: '2024-05-01T08:00:00', scheduleDuration: 'P1D',
      earlyFinish: '2010-01-02T00:00:00',
    });
    assert.equal(taskFinishEpoch(t), utc('2024-05-02T08:00:00'));
  });

  it('a task with no dates at all stays unscheduled', () => {
    const t = task({ scheduleDuration: 'P1D' });
    assert.equal(taskStartEpoch(t), undefined);
    assert.equal(taskFinishEpoch(t), undefined);
  });
});

describe('readers share the resolver (#6803)', () => {
  const data: ScheduleExtraction = {
    hasSchedule: true, workSchedules: [], sequences: [], workCalendars: [],
    tasks: [
      { ...earlyOnly, globalId: 'a', productExpressIds: [7] },
      task({ earlyStart: '2010-09-21T08:00:00', earlyFinish: '2010-09-21T16:00:00' }, { globalId: 'b', productExpressIds: [8] }),
    ],
  };

  it('the Gantt range spans the early windows', () => {
    const range = computeScheduleRange(data);
    assert.equal(range?.start, utc('2010-09-20T08:00:00'));
    assert.equal(range?.end, utc('2010-09-21T16:00:00'));
  });

  it('the 4D animator reveals products by their early window', () => {
    const frame = computeAnimationFrame(data, utc('2010-09-20T23:00:00'), { ...DEFAULT_ANIMATION_SETTINGS });
    assert.ok(!frame.hiddenIds.has(7), 'task a is complete');
    assert.ok(frame.hiddenIds.has(8), 'task b has not started');
  });

  it('the animator honours start + duration like the Gantt does', () => {
    const durationOnly: ScheduleExtraction = {
      ...data,
      tasks: [task({ scheduleStart: '2024-05-01T08:00:00', scheduleDuration: 'P1D' }, { productExpressIds: [9] })],
    };
    const frame = computeAnimationFrame(durationOnly, utc('2024-05-03T00:00:00'), { ...DEFAULT_ANIMATION_SETTINGS });
    assert.equal(frame.stats.complete, 1, 'a start + duration task has a window');
  });

  it('charts phase the early window instead of reporting unscheduled', () => {
    assert.equal(phaseAt(earlyOnly, null), 'scheduled');
    assert.equal(phaseAt(earlyOnly, utc('2010-09-20T12:00:00')), 'in progress');
  });
});
