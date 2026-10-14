/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: `stripScheduleEntities` walks STEP text for record boundaries, the
 * arguments of a relation and the `#N` references in a record. A PAGE
 * directive's apostrophe operand (`'Para \S\' 5'`) is string text; ending the
 * literal there lost the record framing (header included), the relation's
 * attribute split, and read `#22` inside the text as a schedule reference.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripScheduleEntities } from './export-schedule-strip.js';

const STEP = (header: string, data: string[]): string => [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('test'),'2;1');",
  header,
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
  "#22=IFCTASK('real-task',#10,'Real task',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
  "#23=IFCWORKSCHEDULE('real-ws',#10,'Real',$,$,$,$,$,$,$,$,$,$,.PLANNED.);",
  ...data,
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

const PLAIN_HEADER = "FILE_NAME('x','',(''),(''),'','','');";
const HEADER = "FILE_NAME('Para \\S\\' 5; DATA; #22','',(''),(''),'','','');";

test('a nest of a schedule task and a wall keeps the wall, whatever the Name literal holds (#7589)', () => {
  const out = stripScheduleEntities(STEP(HEADER, [
    "#30=IFCRELNESTS('g',#10,'Para \\S\\' 5',$,#40,(#22,#31));",
    "#40=IFCWALL('w',#10,'Wall',$,$,$,$,$,$);",
  ]));
  assert.ok(out.includes("#30=IFCRELNESTS('g',#10,'Para \\S\\' 5',$,#40,(#31));"), out);
  assert.ok(!out.includes('#22='), 'the task record is stripped');
  assert.ok(out.includes("#40=IFCWALL('w',#10,'Wall'"), 'the record after the relation survives');
});

test('`#22` inside a literal is text, not a reference to the schedule task (#7589)', () => {
  const sequence = "#33=IFCRELSEQUENCE('r',#10,'Para \\S\\' #22','Art \\S\\' 7',#41,#42,$,$,.FINISH_START.);";
  const out = stripScheduleEntities(STEP(PLAIN_HEADER, [sequence]));
  assert.ok(out.includes(sequence), 'a relation that only mentions #22 in text is kept');
});

test('record framing survives a `;` after a PAGE operand, in the header and in DATA (#7589)', () => {
  const wall = "#11=IFCWALL('w',#10,'Art \\S\\' 7; #22',$,$,$,$,$,$);";
  const out = stripScheduleEntities(STEP(HEADER, [wall]));
  assert.ok(out.includes(HEADER), 'header kept verbatim');
  assert.ok(out.includes(wall), 'the wall record is kept whole');
  assert.ok(!out.includes('#22=IFCTASK'), 'the task record is still stripped');
  assert.ok(!out.includes('#23=IFCWORKSCHEDULE'), 'the schedule record is still stripped');
});
