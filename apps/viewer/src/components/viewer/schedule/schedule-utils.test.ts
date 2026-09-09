/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import { flattenTaskTree, buildWorkPlanInfo } from './schedule-utils.js';

function task(
  globalId: string,
  parentGlobalId: string | undefined,
  childGlobalIds: string[],
  controllingScheduleGlobalIds: string[] = [],
): ScheduleTaskInfo {
  return {
    expressId: Number(globalId.replace(/\D/g, '')) || 0,
    globalId,
    name: `Task ${globalId}`,
    parentGlobalId,
    childGlobalIds,
    controllingScheduleGlobalIds,
  } as unknown as ScheduleTaskInfo;
}

describe('flattenTaskTree', () => {
  it('flattens an ordinary parent/child chain in depth-first order', () => {
    const root = task('R', undefined, ['A']);
    const a = task('A', 'R', ['B']);
    const b = task('B', 'A', []);
    const data: ScheduleExtraction = { tasks: [root, a, b] } as unknown as ScheduleExtraction;

    const rows = flattenTaskTree(data, new Set(['R', 'A', 'B']));

    assert.deepEqual(rows.map(r => r.task.globalId), ['R', 'A', 'B']);
    assert.deepEqual(rows.map(r => r.depth), [0, 1, 2]);
  });

  // #2864's fix bounded a mapped-item cycle with a depth cap + visited set;
  // this is the same defect class in the Gantt task tree: `childGlobalIds` /
  // `parentGlobalId` are built straight off the file's `IfcRelNests` graph
  // (schedule-extractor.ts's Pass 2) with no cycle check, so a task that
  // nests one of its own ancestors used to recurse `visit()` until the stack
  // overflowed. This is the RED case pre-fix: `A` (root) nests `B`, `B`
  // nests `A` right back.
  it('terminates on a cyclic IfcRelNests chain instead of overflowing the stack', () => {
    const a = task('A', undefined, ['B']);
    const b = task('B', 'A', ['A']);
    const data: ScheduleExtraction = { tasks: [a, b] } as unknown as ScheduleExtraction;

    const rows = flattenTaskTree(data, new Set(['A', 'B']));

    // Each task is placed exactly once, at the depth it was first reached.
    assert.deepEqual(rows.map(r => r.task.globalId).sort(), ['A', 'B']);
    assert.equal(rows.find(r => r.task.globalId === 'A')?.depth, 0);
    assert.equal(rows.find(r => r.task.globalId === 'B')?.depth, 1);
  });

  it('emits a diamond-nested task once, under the first parent reached', () => {
    // R nests both A and B; A and B both nest C. Not a cycle, but the same
    // guard that breaks cycles must not drop or duplicate a legitimately
    // shared descendant.
    const root = task('R', undefined, ['A', 'B']);
    const a = task('A', 'R', ['C']);
    const b = task('B', 'R', ['C']);
    const c = task('C', 'A', []);
    const data: ScheduleExtraction = { tasks: [root, a, b, c] } as unknown as ScheduleExtraction;

    const rows = flattenTaskTree(data, new Set(['R', 'A', 'B', 'C']));

    assert.deepEqual(rows.map(r => r.task.globalId), ['R', 'A', 'C', 'B']);
  });

  it('does not hang when the schedule filter walks a cyclic subtree', () => {
    // A nests B, B nests A back; neither carries the filter's schedule id.
    // `descendantsInSchedule` walks this same cyclic graph to decide
    // visibility, so it needs its own termination guard.
    const a = task('A', undefined, ['B'], []);
    const b = task('B', 'A', ['A'], []);
    const data: ScheduleExtraction = { tasks: [a, b] } as unknown as ScheduleExtraction;

    const rows = flattenTaskTree(data, new Set(['A', 'B']), 'some-other-schedule');

    assert.deepEqual(rows, []);
  });
});

describe('buildWorkPlanInfo', () => {
  it('builds a standalone IfcWorkPlan with the given name and no task links', () => {
    const plan = buildWorkPlanInfo('seed-1', 'Project plan');

    assert.equal(plan.kind, 'WorkPlan');
    assert.equal(plan.name, 'Project plan');
    assert.deepEqual(plan.taskGlobalIds, []);
    assert.equal(typeof plan.globalId, 'string');
    assert.ok(plan.globalId.length > 0);
  });

  it('is deterministic for the same seed and distinct for different seeds', () => {
    const a1 = buildWorkPlanInfo('schedule-gid-A', 'Plan A');
    const a2 = buildWorkPlanInfo('schedule-gid-A', 'Plan A (renamed)');
    const b = buildWorkPlanInfo('schedule-gid-B', 'Plan A');

    // Same seed -> same globalId, independent of the name.
    assert.equal(a1.globalId, a2.globalId);
    // Different seed -> different globalId.
    assert.notEqual(a1.globalId, b.globalId);
  });
});
