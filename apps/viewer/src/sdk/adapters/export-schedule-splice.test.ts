/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Integration tests for `spliceScheduleIntoExport` — the single entry
 * point every export surface routes through.
 *
 * Guards the bug classes that hit production:
 *   • Uint8Array content path silently skipping injection
 *   • `scheduleSourceModelId === null` single-model sessions not
 *     matching the model id
 *   • Edited parsed schedules not triggering the rewrite branch
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spliceScheduleIntoExport } from './export-schedule-splice.js';
import type { ScheduleExtraction, IfcDataStore } from '@ifc-lite/parser';

const SAMPLE_STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('proj',$,'P',$,$,$,$,(#2),#3);
#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#11=IFCWALL('wall-A',#10,'A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const STUB_STORE: IfcDataStore = {
  entities: {
    getExpressIdByGlobalId: (gid: string) => (gid === 'wall-A' ? 11 : -1),
  } as unknown as IfcDataStore['entities'],
} as unknown as IfcDataStore;

function genSchedule(): ScheduleExtraction {
  return {
    hasSchedule: true,
    workSchedules: [{
      expressId: 0, globalId: 'ws', kind: 'WorkSchedule',
      name: 'Gen', startTime: '2024-05-01T08:00:00',
      taskGlobalIds: ['t1'],
    }],
    tasks: [{
      expressId: 0, globalId: 't1', name: 'Install',
      isMilestone: false, predefinedType: 'INSTALLATION',
      childGlobalIds: [],
      productExpressIds: [0],
      productGlobalIds: ['wall-A'],
      controllingScheduleGlobalIds: ['ws'],
      taskTime: {
        scheduleStart: '2024-05-01T08:00:00',
        scheduleFinish: '2024-05-05T17:00:00',
      },
    }],
    sequences: [],
  };
}

// ─── the bug we actually shipped ──────────────────────────────────────

test('splices into Uint8Array content (the regression that shipped)', () => {
  // StepExporter sometimes returns bytes; every string-only short
  // circuit we shipped silently dropped the splice on this path.
  const bytes = new TextEncoder().encode(SAMPLE_STEP);
  const result = { content: bytes as string | Uint8Array };
  const out = spliceScheduleIntoExport(result, 'modelA', STUB_STORE, {
    scheduleData: genSchedule(),
    scheduleIsEdited: false,
    scheduleSourceModelId: 'modelA',
  });
  // Output must remain bytes (contract: preserve caller's content type)…
  assert.ok(out.content instanceof Uint8Array, 'bytes in → bytes out');
  // …and the schedule lines must be present in the decoded text.
  const decoded = new TextDecoder('utf-8').decode(out.content as Uint8Array);
  assert.match(decoded, /=IFCWORKSCHEDULE\(/);
  assert.match(decoded, /=IFCTASK\(/);
});

test('preserves string content type when exporter returns text', () => {
  const result = { content: SAMPLE_STEP as string | Uint8Array };
  const out = spliceScheduleIntoExport(result, 'modelA', STUB_STORE, {
    scheduleData: genSchedule(),
    scheduleIsEdited: false,
    scheduleSourceModelId: 'modelA',
  });
  assert.strictEqual(typeof out.content, 'string', 'string in → string out');
  assert.match(out.content as string, /=IFCWORKSCHEDULE\(/);
});

test('null sourceModelId + in-memory schedule still splices (single-model fallback)', () => {
  // Regression: single-model sessions generated with the Generate
  // dialog left sourceModelId as null. Strict equality against the
  // export target's model id missed every time.
  const result = { content: SAMPLE_STEP as string | Uint8Array };
  const out = spliceScheduleIntoExport(result, '__legacy__', STUB_STORE, {
    scheduleData: genSchedule(),
    scheduleIsEdited: false,
    scheduleSourceModelId: null,
  });
  assert.match(out.content as string, /=IFCTASK\(/);
});

test('sourceModelId mismatch skips the splice (federation safety)', () => {
  const result = { content: SAMPLE_STEP as string | Uint8Array };
  const out = spliceScheduleIntoExport(result, 'modelB', STUB_STORE, {
    scheduleData: genSchedule(),
    scheduleIsEdited: false,
    scheduleSourceModelId: 'modelA', // different model!
  });
  assert.strictEqual(out.content, SAMPLE_STEP, 'foreign schedule is not spliced');
});

test('no schedule + no edit flag is a no-op', () => {
  const result = { content: SAMPLE_STEP as string | Uint8Array };
  const out = spliceScheduleIntoExport(result, 'modelA', STUB_STORE, {
    scheduleData: null,
    scheduleIsEdited: false,
    scheduleSourceModelId: null,
  });
  assert.strictEqual(out.content, SAMPLE_STEP);
});
