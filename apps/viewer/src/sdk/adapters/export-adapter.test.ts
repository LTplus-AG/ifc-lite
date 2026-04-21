/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVisibilityFilterSets, injectScheduleIntoStep } from './export-adapter.js';
import { LEGACY_MODEL_ID } from './model-compat.js';
import type { ScheduleExtraction, IfcDataStore } from '@ifc-lite/parser';

test('resolveVisibilityFilterSets honors legacy single-model hidden and isolated state', () => {
  const state = {
    models: new Map(),
    hiddenEntities: new Set([11, 12]),
    isolatedEntities: new Set([21, 22]),
    hiddenEntitiesByModel: new Map(),
    isolatedEntitiesByModel: new Map(),
  };

  const result = resolveVisibilityFilterSets(state as never, LEGACY_MODEL_ID, new Set([1, 2, 3]), 3);

  assert.equal(result.visibleOnly, false);
  assert.deepEqual([...result.hiddenEntityIds], [11, 12]);
  assert.deepEqual(result.isolatedEntityIds ? [...result.isolatedEntityIds] : null, [21, 22]);
});

// ─── injectScheduleIntoStep ─────────────────────────────────────────────

const STUB_STORE: IfcDataStore = {
  entities: {
    getExpressIdByGlobalId: (gid: string) => {
      const map: Record<string, number> = { 'wall-A': 11, 'wall-B': 12 };
      return map[gid] ?? -1;
    },
  } as unknown as IfcDataStore['entities'],
} as unknown as IfcDataStore;

const SAMPLE_STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('proj-gid',$,'P',$,$,$,$,(#2),#3);
#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#11=IFCWALL('wall-A-gid',#10,'A',$,$,$,$,$,$);
#12=IFCWALL('wall-B-gid',#10,'B',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

function makeGeneratedSchedule(): ScheduleExtraction {
  return {
    hasSchedule: true,
    workSchedules: [{
      expressId: 0, globalId: 'sched-gid', kind: 'WorkSchedule',
      name: 'Generated', startTime: '2024-05-01T08:00:00',
      finishTime: '2024-05-30T17:00:00', predefinedType: 'PLANNED',
      taskGlobalIds: ['task-1'],
    }],
    tasks: [{
      expressId: 0, globalId: 'task-1', name: 'Install walls',
      isMilestone: false, predefinedType: 'INSTALLATION',
      childGlobalIds: [],
      productExpressIds: [0, 0],
      productGlobalIds: ['wall-A', 'wall-B'],
      controllingScheduleGlobalIds: ['sched-gid'],
      taskTime: {
        scheduleStart: '2024-05-01T08:00:00',
        scheduleFinish: '2024-05-06T17:00:00',
        scheduleDuration: 'P5D',
      },
    }],
    sequences: [],
  };
}

test('injectScheduleIntoStep is a no-op when scheduleData is null', () => {
  const out = injectScheduleIntoStep(SAMPLE_STEP, null, STUB_STORE);
  assert.equal(out, SAMPLE_STEP);
});

test('injectScheduleIntoStep is a no-op when every task has a positive expressId (parsed schedule already in STEP)', () => {
  const parsed: ScheduleExtraction = {
    hasSchedule: true, workSchedules: [], sequences: [],
    tasks: [{
      expressId: 999, globalId: 'task-x', name: 'Already in file',
      isMilestone: false, childGlobalIds: [],
      productExpressIds: [], productGlobalIds: [],
      controllingScheduleGlobalIds: [],
    }],
  };
  const out = injectScheduleIntoStep(SAMPLE_STEP, parsed, STUB_STORE);
  assert.equal(out, SAMPLE_STEP);
});

test('injectScheduleIntoStep splices generated schedule entities before the DATA section ENDSEC', () => {
  const out = injectScheduleIntoStep(SAMPLE_STEP, makeGeneratedSchedule(), STUB_STORE);
  // The new entities must appear in the file.
  assert.match(out, /=IFCWORKSCHEDULE\(/);
  assert.match(out, /=IFCTASK\(/);
  assert.match(out, /=IFCTASKTIME\(/);
  assert.match(out, /=IFCRELASSIGNSTOCONTROL\(/);
  assert.match(out, /=IFCRELASSIGNSTOPROCESS\(/);
  // Trailer must still be intact and well-formed.
  assert.ok(out.endsWith('END-ISO-10303-21;\n'));
  // Splice location must be strictly INSIDE the DATA section, not just
  // before `END-ISO-10303-21;` — entities outside the DATA block are
  // invalid STEP placement.
  const dataStartIdx = out.indexOf('DATA;');
  const dataEndIdx = out.indexOf('ENDSEC;', dataStartIdx);
  const wsIdx = out.indexOf('=IFCWORKSCHEDULE(');
  assert.ok(dataStartIdx >= 0, 'DATA; section header present');
  assert.ok(dataEndIdx > dataStartIdx, 'DATA ENDSEC comes after DATA;');
  assert.ok(wsIdx > dataStartIdx && wsIdx < dataEndIdx,
    `IfcWorkSchedule splice (${wsIdx}) must land inside DATA..ENDSEC (${dataStartIdx}..${dataEndIdx})`);
});

test('injectScheduleIntoStep partitions mixed schedules — only generated tasks are emitted', () => {
  const mixed: ScheduleExtraction = {
    hasSchedule: true,
    workSchedules: [{
      expressId: 0, globalId: 'gen-sched', kind: 'WorkSchedule',
      name: 'Gen', startTime: '2024-05-01T08:00:00',
      taskGlobalIds: ['gen-task'],
    }],
    tasks: [
      {
        // Parsed — must NOT be re-emitted (already in source STEP).
        expressId: 99, globalId: 'parsed-task', name: 'Already-in-file',
        isMilestone: false, childGlobalIds: [],
        productExpressIds: [], productGlobalIds: [],
        controllingScheduleGlobalIds: [],
      },
      {
        // Generated — must be emitted.
        expressId: 0, globalId: 'gen-task', name: 'Fresh',
        isMilestone: false, childGlobalIds: [],
        productExpressIds: [0], productGlobalIds: ['wall-A'],
        controllingScheduleGlobalIds: ['gen-sched'],
        taskTime: { scheduleStart: '2024-05-01T08:00:00', scheduleFinish: '2024-05-05T17:00:00' },
      },
    ],
    sequences: [],
  };
  const out = injectScheduleIntoStep(SAMPLE_STEP, mixed, STUB_STORE);
  // The generated task should be emitted…
  assert.match(out, /IFCTASK\('[^']+',[^)]*'Fresh'/);
  // …but the parsed task name must not appear a second time.
  assert.ok(!/Already-in-file/.test(out), 'parsed task is not re-emitted');
});

test('injectScheduleIntoStep allocates IDs above the existing maximum', () => {
  const out = injectScheduleIntoStep(SAMPLE_STEP, makeGeneratedSchedule(), STUB_STORE);
  // Existing max in SAMPLE_STEP is 12; first new entity must be #13 or higher.
  const firstNewId = out.match(/(?<=\n)#(\d+)=IFCWORKSCHEDULE\(/);
  assert.ok(firstNewId);
  assert.ok(parseInt(firstNewId![1], 10) > 12);
});

test('injectScheduleIntoStep references the existing IfcOwnerHistory', () => {
  const out = injectScheduleIntoStep(SAMPLE_STEP, makeGeneratedSchedule(), STUB_STORE);
  // Entities should reference #10 (the stub IfcOwnerHistory) for ownership.
  const ws = out.split('\n').find(l => l.includes('=IFCWORKSCHEDULE('));
  assert.ok(ws);
  assert.match(ws!, /=IFCWORKSCHEDULE\('[^']+',#10/);
});

test('injectScheduleIntoStep resolves product GlobalIds via the data store', () => {
  const out = injectScheduleIntoStep(SAMPLE_STEP, makeGeneratedSchedule(), STUB_STORE);
  const proc = out.split('\n').find(l => l.includes('=IFCRELASSIGNSTOPROCESS('));
  assert.ok(proc);
  // wall-A → 11, wall-B → 12 per STUB_STORE's resolver.
  assert.match(proc!, /\(#11,#12\)/);
});
