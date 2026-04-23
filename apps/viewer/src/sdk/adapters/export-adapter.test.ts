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

// ─── rewrite mode (P1: schedule-as-unit export) ───────────────────────

/**
 * STEP fixture with an existing parsed schedule block — exercises the
 * rewrite path that strips all schedule entities and re-emits fresh.
 */
const SAMPLE_STEP_WITH_SCHEDULE = `ISO-10303-21;
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
#20=IFCWORKSCHEDULE('orig-sched-gid',#10,'Original',$,$,$,$,$,$,$,$,$,$,$,.PLANNED.);
#21=IFCTASKTIME($,$,$,.WORKTIME.,'P3D','2024-01-01T08:00:00','2024-01-04T08:00:00',$,$,$,$,$,$,$,$,$,$,$,$,$);
#22=IFCTASK('orig-task-gid',#10,'Original task',$,$,$,$,$,$,.F.,$,#21,.CONSTRUCTION.);
#23=IFCRELASSIGNSTOCONTROL('rel-ctl',#10,$,$,(#22),$,#20);
#24=IFCRELASSIGNSTOPROCESS('rel-proc',#10,$,$,(#11,#12),$,#22);
ENDSEC;
END-ISO-10303-21;
`;

test('injectScheduleIntoStep rewrite mode strips the original schedule block', () => {
  // No in-memory schedule + edited flag → user deleted every task.
  const out = injectScheduleIntoStep(
    SAMPLE_STEP_WITH_SCHEDULE,
    null,
    STUB_STORE,
    { scheduleIsEdited: true },
  );
  assert.ok(!out.includes('IFCWORKSCHEDULE'), 'original workschedule removed');
  assert.ok(!out.includes('IFCTASK('), 'original task removed');
  assert.ok(!out.includes('IFCTASKTIME'), 'original task time removed');
  assert.ok(!out.includes('IFCRELASSIGNSTOCONTROL'), 'rel-assigns-to-control removed');
  assert.ok(!out.includes('IFCRELASSIGNSTOPROCESS'), 'rel-assigns-to-process removed');
  // Non-schedule entities must remain intact.
  assert.ok(out.includes('IFCWALL'), 'walls preserved');
  assert.ok(out.includes('IFCOWNERHISTORY'), 'owner history preserved');
  assert.ok(out.includes('IFCPROJECT'), 'project preserved');
});

test('injectScheduleIntoStep rewrite mode replaces the original schedule with the edited one', () => {
  const edited: ScheduleExtraction = {
    hasSchedule: true,
    workSchedules: [{
      expressId: 20, globalId: 'orig-sched-gid', kind: 'WorkSchedule',
      name: 'Renamed schedule',
      startTime: '2024-05-01T08:00:00',
      finishTime: '2024-05-10T17:00:00',
      predefinedType: 'PLANNED',
      taskGlobalIds: ['orig-task-gid'],
    }],
    tasks: [{
      expressId: 22, globalId: 'orig-task-gid', name: 'Renamed task',
      isMilestone: false, predefinedType: 'CONSTRUCTION',
      childGlobalIds: [],
      productExpressIds: [11],
      productGlobalIds: ['wall-A'],
      controllingScheduleGlobalIds: ['orig-sched-gid'],
      taskTime: {
        scheduleStart: '2024-05-01T08:00:00',
        scheduleFinish: '2024-05-05T17:00:00',
        scheduleDuration: 'P5D',
      },
    }],
    sequences: [],
  };
  const out = injectScheduleIntoStep(
    SAMPLE_STEP_WITH_SCHEDULE,
    edited,
    STUB_STORE,
    { scheduleIsEdited: true },
  );

  // Old names/timestamps gone.
  assert.ok(!out.includes("'Original'"), 'original schedule name stripped');
  assert.ok(!out.includes("'Original task'"), 'original task name stripped');
  assert.ok(!out.includes('P3D'), 'original duration stripped');
  assert.ok(!out.includes('2024-01-01T08:00:00'), 'original date stripped');

  // New names/timestamps present.
  assert.ok(out.includes("'Renamed schedule'"), 'new schedule name present');
  assert.ok(out.includes("'Renamed task'"), 'new task name present');
  assert.ok(out.includes('P5D'), 'new duration present');
  assert.ok(out.includes('2024-05-01T08:00:00'), 'new start date present');

  // Globalids must be preserved (same identity).
  assert.ok(out.includes("'orig-sched-gid'"), 'work-schedule globalId preserved');
  assert.ok(out.includes("'orig-task-gid'"), 'task globalId preserved');

  // No duplicate emission.
  const workScheduleCount = (out.match(/=IFCWORKSCHEDULE\(/g) ?? []).length;
  const taskCount = (out.match(/=IFCTASK\(/g) ?? []).length;
  assert.equal(workScheduleCount, 1, 'exactly one work schedule in output');
  assert.equal(taskCount, 1, 'exactly one task in output');
});

test('injectScheduleIntoStep rewrite mode leaves non-schedule entities byte-identical', () => {
  // Input has project, owner history, two walls, plus a schedule block.
  // After rewrite with empty schedule, the non-schedule lines should be
  // intact (aside from re-ordering they don't do).
  const out = injectScheduleIntoStep(
    SAMPLE_STEP_WITH_SCHEDULE,
    null,
    STUB_STORE,
    { scheduleIsEdited: true },
  );
  // Each non-schedule line from the input must appear in the output.
  for (const line of [
    "#1=IFCPROJECT('proj-gid',$,'P',$,$,$,$,(#2),#3);",
    '#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);',
    "#11=IFCWALL('wall-A-gid',#10,'A',$,$,$,$,$,$);",
    "#12=IFCWALL('wall-B-gid',#10,'B',$,$,$,$,$,$);",
  ]) {
    assert.ok(out.includes(line), `preserved line: ${line}`);
  }
});

test('injectScheduleIntoStep without scheduleIsEdited preserves append-only legacy behaviour', () => {
  // Mixed schedule (one parsed, one generated) without the edit flag →
  // only the generated tail is emitted, original parsed task stays intact.
  const mixed: ScheduleExtraction = {
    hasSchedule: true,
    workSchedules: [],
    tasks: [
      {
        expressId: 99, globalId: 'parsed', name: 'Parsed task', isMilestone: false,
        childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
        controllingScheduleGlobalIds: [],
      },
      {
        expressId: 0, globalId: 'fresh', name: 'Fresh', isMilestone: false,
        childGlobalIds: [], productExpressIds: [0], productGlobalIds: ['wall-A'],
        controllingScheduleGlobalIds: [],
        taskTime: { scheduleStart: '2024-05-01T08:00:00', scheduleFinish: '2024-05-05T17:00:00' },
      },
    ],
    sequences: [],
  };
  // Legacy (no options): only generated should splice in, parsed name
  // must not re-appear.
  const legacy = injectScheduleIntoStep(SAMPLE_STEP_WITH_SCHEDULE, mixed, STUB_STORE);
  assert.match(legacy, /'Fresh'/);
  // The original schedule block stays untouched because we're in append mode.
  assert.ok(legacy.includes("'Original'"), 'original schedule block preserved in append mode');
});

// ─── edge cases flagged in the retrospective ────────────────────────

test('stripScheduleEntities preserves IFCTASK as substring inside non-task strings', () => {
  // Defensive: an IFC file could (unusually) contain a string attribute
  // whose text literally spells "IFCTASK" or "IFCWORKSCHEDULE". The
  // line-regex is anchored to leading whitespace + `#N=TYPE` so it
  // shouldn't match substrings, but let's verify.
  const stepWithTrickyString = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('proj',$,'P',$,$,$,$,(#2),#3);
#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#11=IFCWALL('wall-A',#10,'Description mentions IFCTASK for context',$,$,$,$,$,$);
#20=IFCWORKSCHEDULE('real-ws',#10,'Real',$,$,$,$,$,$,$,$,$,$,.PLANNED.);
#22=IFCTASK('real-task',#10,'Real task',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);
ENDSEC;
END-ISO-10303-21;
`;
  const out = injectScheduleIntoStep(stepWithTrickyString, null, STUB_STORE, {
    scheduleIsEdited: true,
  });
  // Real schedule entities stripped…
  assert.ok(!out.includes("'real-ws'"), 'real workschedule stripped');
  assert.ok(!out.includes("'real-task'"), 'real task stripped');
  // …but the wall with "IFCTASK" in its description must survive.
  assert.ok(
    out.includes('Description mentions IFCTASK for context'),
    'wall with IFCTASK substring in string attribute preserved',
  );
});

test('stripScheduleEntities handles \\r\\n line endings', () => {
  // Some STEP writers emit CRLF; node tests typically run with LF.
  // Verify the splitter treats \r\n correctly — each line ends up with
  // its trailing \r, gets the same regex treatment, and rejoins.
  const crlf = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('test'),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('proj',$,'P',$,$,$,$,(#2),#3);",
    "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
    "#11=IFCWALL('wall-A',#10,'A',$,$,$,$,$,$);",
    "#20=IFCWORKSCHEDULE('ws',#10,'WS',$,$,$,$,$,$,$,$,$,$,.PLANNED.);",
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\r\n');
  const out = injectScheduleIntoStep(crlf, null, STUB_STORE, { scheduleIsEdited: true });
  assert.ok(!out.includes('IFCWORKSCHEDULE'), 'CRLF workschedule stripped');
  assert.ok(out.includes('IFCWALL'), 'CRLF non-schedule line preserved');
  // \r\n preservation not strictly required; as long as each kept line
  // survives with its content, we pass.
});

test('stripScheduleEntities handles multi-line STEP entities', () => {
  // Valid STEP allows entities to span multiple lines (whitespace is
  // tolerated anywhere outside string literals). The old line-by-line
  // regex would have stripped only the first line of a multi-line
  // IFCTASK, leaving its attribute-list continuation as orphan garbage.
  // The statement-level tokenizer handles this correctly.
  const multiLine = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('test'),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('proj',$,'P',$,$,$,$,(#2),#3);",
    "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
    "#11=IFCWALL('wall-A',#10,'A',$,$,$,$,$,$);",
    // Split the IFCTASK across 3 lines. Valid STEP.
    "#20=IFCTASK(",
    "  'multi-task',#10,'Multi-line task',",
    "  $,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
    // Multi-line workschedule too.
    "#30=IFCWORKSCHEDULE('ws-multi',",
    "  #10,'WS multi',$,$,$,$,$,$,$,$,$,$,.PLANNED.);",
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
  const out = injectScheduleIntoStep(multiLine, null, STUB_STORE, { scheduleIsEdited: true });
  // Every schedule artifact must be gone — no orphan attribute lines
  // left behind.
  assert.ok(!out.includes("'multi-task'"), 'multi-line task stripped');
  assert.ok(!out.includes("'ws-multi'"), 'multi-line workschedule stripped');
  assert.ok(!out.includes('Multi-line task'), 'orphan attribute line not left behind');
  assert.ok(!out.includes('WS multi'), 'orphan workschedule continuation not left behind');
  // Non-schedule entities stay.
  assert.ok(out.includes("'wall-A'"), 'wall survives multi-line strip');
  assert.ok(out.includes('IFCPROJECT'), 'project survives multi-line strip');
});

test("stripScheduleEntities respects ';' inside string literals", () => {
  // A string attribute that literally contains `;` must not confuse
  // the statement tokenizer — STEP terminates statements with `;`
  // outside string literals only.
  const trickySemicolon = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('test'),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('proj',$,'P',$,$,$,$,(#2),#3);",
    "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
    // IFC string-escape: `''` means a single quote. `;` inside a
    // string literal is NOT a statement terminator.
    "#11=IFCWALL('w;all','B','A;B;C',$,$,$,$,$,$);",
    "#20=IFCWORKSCHEDULE('ws',#10,'note;with;semis',$,$,$,$,$,$,$,$,$,$,.PLANNED.);",
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
  const out = injectScheduleIntoStep(trickySemicolon, null, STUB_STORE, { scheduleIsEdited: true });
  assert.ok(!out.includes("'ws'"), 'workschedule stripped despite semicolons in string');
  assert.ok(out.includes("'w;all'"), 'wall with semicolon in name preserved');
  assert.ok(out.includes('A;B;C'), 'wall attribute with semicolons preserved');
});
