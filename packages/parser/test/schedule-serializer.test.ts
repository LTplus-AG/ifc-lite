/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { serializeScheduleToStep } from '../src/schedule-serializer.js';
import type { ScheduleExtraction } from '../src/schedule-extractor.js';

function makeExtraction(): ScheduleExtraction {
  return {
    hasSchedule: true,
    workSchedules: [{
      expressId: 0, globalId: 'sched-gid', kind: 'WorkSchedule',
      name: 'Main', startTime: '2024-05-01T08:00:00',
      finishTime: '2024-06-01T17:00:00',
      predefinedType: 'PLANNED',
      taskGlobalIds: ['task-a', 'task-b'],
    }],
    tasks: [
      {
        expressId: 0, globalId: 'task-a', name: 'Foundations',
        isMilestone: false, predefinedType: 'CONSTRUCTION',
        childGlobalIds: [],
        productExpressIds: [101, 102], productGlobalIds: ['p101', 'p102'],
        controllingScheduleGlobalIds: ['sched-gid'],
        taskTime: {
          scheduleStart: '2024-05-01T08:00:00',
          scheduleFinish: '2024-05-06T17:00:00',
          scheduleDuration: 'P5D',
          durationType: 'WORKTIME',
          isCritical: true,
          completion: 50,
        },
      },
      {
        expressId: 0, globalId: 'task-b', name: 'Walls',
        isMilestone: false, predefinedType: 'INSTALLATION',
        childGlobalIds: [],
        productExpressIds: [103], productGlobalIds: ['p103'],
        controllingScheduleGlobalIds: ['sched-gid'],
        taskTime: {
          scheduleStart: '2024-05-08T08:00:00',
          scheduleFinish: '2024-05-15T17:00:00',
          scheduleDuration: 'P5D',
        },
      },
    ],
    sequences: [{
      globalId: 'seq-1',
      relatingTaskGlobalId: 'task-a',
      relatedTaskGlobalId: 'task-b',
      sequenceType: 'FINISH_START',
      timeLagDuration: 'P2D',
      timeLagSeconds: 2 * 86400,
    }],
  };
}

describe('serializeScheduleToStep', () => {
  it('emits IFCWORKSCHEDULE / IFCTASK / IFCTASKTIME with correct attribute counts', () => {
    const result = serializeScheduleToStep(makeExtraction(), { nextId: 1000, ownerHistoryId: 42 });

    const ws = result.lines.find(l => l.includes('=IFCWORKSCHEDULE('));
    expect(ws).toBeDefined();
    expect(ws).toContain("'sched-gid'");
    expect(ws).toContain("'Main'");
    expect(ws).toContain('#42');
    expect(ws).toContain('.PLANNED.');
    expect(ws).toContain("'2024-05-01T08:00:00'");
    expect(ws).toContain("'2024-06-01T17:00:00'");

    // IFC4 IfcWorkSchedule has 14 attributes — count commas + 1 inside the parens.
    const wsArgs = ws!.match(/=IFCWORKSCHEDULE\((.+)\);$/)![1];
    const attributeCount = countTopLevelArgs(wsArgs);
    expect(attributeCount).toBe(14);

    const task = result.lines.find(l => l.includes("'Foundations'"));
    expect(task).toBeDefined();
    expect(task).toContain('=IFCTASK(');
    expect(task).toContain('.CONSTRUCTION.');
    const taskArgs = task!.match(/=IFCTASK\((.+)\);$/)![1];
    expect(countTopLevelArgs(taskArgs)).toBe(13);

    const taskTime = result.lines.find(l => l.includes('=IFCTASKTIME('));
    expect(taskTime).toBeDefined();
    expect(taskTime).toContain("'P5D'");
    expect(taskTime).toContain('.WORKTIME.');
    expect(taskTime).toContain('.T.'); // IsCritical=true
    expect(taskTime).toContain('50.'); // Completion as STEP REAL
    const ttArgs = taskTime!.match(/=IFCTASKTIME\((.+)\);$/)![1];
    expect(countTopLevelArgs(ttArgs)).toBe(20);
  });

  it('emits IFCRELSEQUENCE with IFCLAGTIME when timeLagDuration is set', () => {
    const result = serializeScheduleToStep(makeExtraction(), { nextId: 1, ownerHistoryId: 42 });
    const lag = result.lines.find(l => l.includes('=IFCLAGTIME('));
    expect(lag).toBeDefined();
    expect(lag).toContain("IFCDURATION('P2D')");
    expect(lag).toContain('.WORKTIME.');

    const seq = result.lines.find(l => l.includes('=IFCRELSEQUENCE('));
    expect(seq).toBeDefined();
    expect(seq).toContain('.FINISH_START.');
    // Seq references the lag (#N) — non-trivial check that the lag was wired in.
    expect(seq).toMatch(/IFCRELSEQUENCE\([^)]*,#\d+,\.FINISH_START\./);
  });

  it('emits IFCRELASSIGNSTOCONTROL binding tasks to the work schedule', () => {
    const result = serializeScheduleToStep(makeExtraction(), { nextId: 1 });
    const rel = result.lines.find(l => l.includes('=IFCRELASSIGNSTOCONTROL('));
    expect(rel).toBeDefined();
    // Two tasks → list of two #N refs.
    expect(rel).toMatch(/\(#\d+,#\d+\)/);
  });

  it('emits IFCRELASSIGNSTOPROCESS binding products to each task', () => {
    const result = serializeScheduleToStep(makeExtraction(), { nextId: 1 });
    const procs = result.lines.filter(l => l.includes('=IFCRELASSIGNSTOPROCESS('));
    expect(procs).toHaveLength(2);
    // First task has two products (101, 102) → list of two refs.
    expect(procs[0]).toContain('(#101,#102)');
  });

  it('emits IFCRELNESTS for tasks with childGlobalIds', () => {
    const data = makeExtraction();
    data.tasks.push({
      expressId: 0, globalId: 'task-parent', name: 'Summary',
      isMilestone: false, childGlobalIds: ['task-a', 'task-b'],
      productExpressIds: [], productGlobalIds: [],
      controllingScheduleGlobalIds: [],
    });
    const result = serializeScheduleToStep(data, { nextId: 1 });
    const nests = result.lines.find(l => l.includes('=IFCRELNESTS('));
    expect(nests).toBeDefined();
    expect(nests).toMatch(/\(#\d+,#\d+\)/);
  });

  it('uses $ for OwnerHistory when ownerHistoryId is omitted', () => {
    const result = serializeScheduleToStep(makeExtraction(), { nextId: 1 });
    const ws = result.lines.find(l => l.includes('=IFCWORKSCHEDULE('));
    // First two attributes are GlobalId + OwnerHistory.
    expect(ws).toMatch(/IFCWORKSCHEDULE\('[^']+',\$,/);
  });

  it('skips IfcTaskTime when no time fields are set', () => {
    const data: ScheduleExtraction = {
      hasSchedule: true, workSchedules: [], sequences: [],
      tasks: [{
        expressId: 0, globalId: 'bare-task', name: 'Untimed',
        isMilestone: true, childGlobalIds: [],
        productExpressIds: [], productGlobalIds: [],
        controllingScheduleGlobalIds: [],
      }],
    };
    const result = serializeScheduleToStep(data, { nextId: 1 });
    expect(result.stats.taskTimes).toBe(0);
    expect(result.lines.some(l => l.includes('=IFCTASKTIME('))).toBe(false);
    const task = result.lines.find(l => l.includes("'Untimed'"));
    // 12th attribute (TaskTime) must be `$`.
    expect(task).toMatch(/=IFCTASK\([^)]*,\$,\.NOTDEFINED\.\)|=IFCTASK\([^)]*,\$,\$\)/);
  });

  it('returns the next free express ID', () => {
    const result = serializeScheduleToStep(makeExtraction(), { nextId: 100 });
    expect(result.nextId).toBeGreaterThan(100);
    expect(result.nextId).toBe(100 + result.lines.length);
  });

  it('resolveProductExpressId is preferred when product globalIds are known', () => {
    const data = makeExtraction();
    data.tasks[0].productExpressIds = [0, 0];
    data.tasks[0].productGlobalIds = ['p101', 'p102'];
    const remap: Record<string, number> = { p101: 9001, p102: 9002 };
    const result = serializeScheduleToStep(data, {
      nextId: 1,
      resolveProductExpressId: (gid) => remap[gid],
    });
    const proc = result.lines.find(l => l.includes('=IFCRELASSIGNSTOPROCESS('));
    expect(proc).toContain('(#9001,#9002)');
  });
});

/** Count top-level comma-separated arguments in a STEP attribute list. */
function countTopLevelArgs(args: string): number {
  let depth = 0;
  let inStr = false;
  let count = 1;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "'" && args[i - 1] !== '\\') inStr = !inStr;
    if (inStr) continue;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) count++;
  }
  return count;
}
