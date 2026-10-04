/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6749 — an edited schedule export strips every IfcTask and re-emits the
 * schedule. A task's IfcRelAssignsToProduct (its output product) must be
 * stripped with it and re-emitted once, pointing at the new task; before,
 * it survived the strip and dangled at a deleted IfcTask while the output
 * itself was lost.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore, ScheduleExtraction } from '@ifc-lite/parser';
import { injectScheduleIntoStep } from './export-adapter.js';
import { stripScheduleEntities } from './export-schedule-strip.js';

const step = (body: string[]) => [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('test'),'2;1');",
  "FILE_NAME('','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
  "#11=IFCWALL('wall-A',#10,'A',$,$,$,$,$,$);",
  "#12=IFCWALL('wall-B',#10,'B',$,$,$,$,$,$);",
  ...body,
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

const STORE = {
  entities: {
    getExpressIdByGlobalId: (gid: string) => ({ 'wall-A': 11, 'wall-B': 12 } as Record<string, number>)[gid] ?? -1,
  },
} as unknown as IfcDataStore;

test('stripScheduleEntities drops task outputs and keeps cost items on the product (#6749)', () => {
  const out = stripScheduleEntities(step([
    "#21=IFCTASK('task',#10,'Task',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
    "#22=IFCCOSTITEM('cost',#10,'Cost',$,$,$,$,$,$);",
    "#30=IFCRELASSIGNSTOPRODUCT('task-only',#10,$,$,(#21),$,#11);",
    "#31=IFCRELASSIGNSTOPRODUCT('mixed',#10,$,$,(#21,#22),$,#12);",
    "#32=IFCRELASSIGNSTOPRODUCT('cost-only',#10,$,$,(#22),$,#11);",
    // STEP permits comments between tokens.
    "#33=IFCRELASSIGNSTOPRODUCT('commented',#10,$,$,(#21 /* task */,#22),$,#11);",
  ]));

  assert.ok(!out.includes("'task-only'"), 'a relation naming only the task goes with it');
  assert.ok(out.includes("#31=IFCRELASSIGNSTOPRODUCT('mixed',#10,$,$,(#22),$,#12);"), 'the cost item stays on the product');
  assert.ok(out.includes("#32=IFCRELASSIGNSTOPRODUCT('cost-only',#10,$,$,(#22),$,#11);"));
  assert.ok(out.includes("#33=IFCRELASSIGNSTOPRODUCT('commented',#10,$,$,(#22),$,#11);"), 'a comment does not drop the cost item');
});

test('edited export re-emits a task output once, bound to the new task (#6749)', () => {
  const source = step([
    "#21=IFCTASK('task-1',#10,'Build wall A',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
    "#30=IFCRELASSIGNSTOPRODUCT('out',#10,$,$,(#21),$,#11);",
  ]);
  const schedule: ScheduleExtraction = {
    hasSchedule: true, workSchedules: [], sequences: [], workCalendars: [],
    tasks: [{
      expressId: 21, globalId: 'task-1', name: 'Build wall A (renamed)',
      isMilestone: false, predefinedType: 'CONSTRUCTION',
      childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
      outputProductExpressIds: [11], outputProductGlobalIds: ['wall-A'],
      controllingScheduleGlobalIds: [],
    }],
  };

  const out = injectScheduleIntoStep(source, schedule, STORE, { scheduleIsEdited: true });

  const task = /#(\d+)=IFCTASK\('task-1'/.exec(out);
  assert.ok(task, 'task re-emitted');
  assert.notEqual(task[1], '21', 'under a fresh express ID');
  const rels = out.match(/IFCRELASSIGNSTOPRODUCT\([^;]*;/g) ?? [];
  assert.equal(rels.length, 1, 'exactly one output relation: the stale one is gone');
  assert.match(rels[0], new RegExp(`,\\(#${task[1]}\\),\\$,#11\\);$`));
  assert.ok(!out.includes('IFCRELASSIGNSTOPROCESS'), 'the output did not turn into an input');
});
