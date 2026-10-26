/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync } from '@ifc-lite/wasm';
import { IfcParser, type ScheduleExtraction } from '@ifc-lite/parser';
import { exportModelStep } from './model-step-export.js';

const STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmQ',$,'Project',$,$,$,$,(#10),#4);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCUNITASSIGNMENT((#2));
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#14,$,$);
#14=IFCCARTESIANPOINT((20.,0.,0.));
#22=IFCLOCALPLACEMENT($,#11);
#23=IFCLOCALPLACEMENT($,#13);
#41=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.,8.);
#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,2.);
#43=IFCDIRECTION((0.,0.,1.));
#44=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));
#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#50=IFCSLAB('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Kept',$,$,#22,#45,$,.FLOOR.);
#51=IFCSLAB('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Outside',$,$,#23,#45,$,.FLOOR.);
ENDSEC;
END-ISO-10303-21;`;

const schedule = (): ScheduleExtraction => ({
  hasSchedule: true, workCalendars: [], sequences: [],
  workSchedules: [{ expressId: 0, globalId: 'ws', kind: 'WorkSchedule', name: 'Gen', startTime: '2024-05-01T08:00:00', taskGlobalIds: ['t1'] }],
  tasks: [
    { expressId: 0, globalId: 't1', name: 'AttachedTask', isMilestone: false, predefinedType: 'INSTALLATION', childGlobalIds: [],
      productExpressIds: [0], productGlobalIds: ['0M7tQ9Jbj1BAeHd7rqnDmR'], controllingScheduleGlobalIds: ['ws'],
      taskTime: { scheduleStart: '2024-05-01T08:00:00', scheduleFinish: '2024-05-05T17:00:00' } },
    { expressId: 0, globalId: 't2', name: 'StandaloneTask', isMilestone: false, predefinedType: 'INSTALLATION', childGlobalIds: [],
      productExpressIds: [], productGlobalIds: [], controllingScheduleGlobalIds: [],
      taskTime: { scheduleStart: '2024-05-06T08:00:00', scheduleFinish: '2024-05-07T17:00:00' } },
  ],
});

test('#7711 a section crop keeps the schedule the dialog spliced into the download', async () => {
  initSync({ module: new Uint8Array(readFileSync(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url))) });
  const bytes = new TextEncoder().encode(STEP);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const result = await exportModelStep({
    modelId: 'm', dataStore,
    section: { planes: [{ normal: [1, 0, 0], offset: 0 }], mode: 'trim' },
    options: { schema: 'IFC4', includeGeometry: true, applyMutations: true, visibleOnly: true },
    scheduleState: { scheduleData: schedule(), scheduleIsEdited: false, scheduleSourceModelId: 'm' },
  });
  const text = typeof result.content === 'string' ? result.content : new TextDecoder().decode(result.content);
  assert.match(text, /'Kept'/, 'the crossing product survives');
  assert.doesNotMatch(text, /'Outside'/, 'the outside product is omitted');
  assert.match(text, /AttachedTask/, 'the task attached to a kept product survives the crop');
  assert.match(text, /StandaloneTask/, 'an unattached generated task survives the crop');
});
