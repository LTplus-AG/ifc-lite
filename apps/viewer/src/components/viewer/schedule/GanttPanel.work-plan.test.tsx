/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import {
  IfcParser,
  serializeScheduleToStep,
  type IfcDataStore,
  type ScheduleExtraction,
  type ScheduleTaskInfo,
  type WorkScheduleInfo,
} from '@ifc-lite/parser';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { GanttPanel } from './GanttPanel.js';

function control(
  kind: WorkScheduleInfo['kind'],
  globalId: string,
  name: string,
  links: Pick<WorkScheduleInfo, 'parentPlanGlobalId' | 'childScheduleGlobalIds'> = {},
): WorkScheduleInfo {
  return {
    expressId: 0,
    globalId,
    kind,
    name,
    taskGlobalIds: [],
    ...links,
  };
}

async function parseSchedule(
  workSchedules: WorkScheduleInfo[],
  tasks: ScheduleTaskInfo[] = [],
): Promise<IfcDataStore> {
  const extraction: ScheduleExtraction = {
    hasSchedule: true,
    workSchedules,
    tasks,
    sequences: [],
    workCalendars: [],
  };
  const serialized = serializeScheduleToStep(extraction, { nextId: 100, ownerHistoryId: 10 });
  const step = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('work plan UI fixture'),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('project-guid',#10,'Project',$,$,$,$,$,$);",
    '#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);',
    ...serialized.lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
  const bytes = new TextEncoder().encode(step);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    { disableWorkerScan: true },
  );
}

function model(id: string, store: IfcDataStore, idOffset: number): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: store,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset,
    maxExpressId: 1_000,
  };
}

afterEach(() => {
  cleanup();
  useViewerStore.getState().resetViewerState();
});

describe('GanttPanel loaded IfcWorkPlan read path', () => {
  it('renders the active model plans and follows federated active-model changes (#4834)', async () => {
    const storeA = await parseSchedule([
      control('WorkSchedule', 'schedule-a', 'Shell programme', { parentPlanGlobalId: 'plan-a' }),
      control('WorkSchedule', 'schedule-loose', 'Site logistics'),
      control('WorkPlan', 'plan-a', 'Delivery plan', { childScheduleGlobalIds: ['schedule-a'] }),
      control('WorkPlan', 'plan-empty', 'Future works', { childScheduleGlobalIds: [] }),
    ]);
    const storeB = await parseSchedule([
      control('WorkPlan', 'plan-b', 'Federated fit-out plan', { childScheduleGlobalIds: [] }),
    ]);
    const modelA = model('model-a', storeA, 0);
    const modelB = model('model-b', storeB, 1_000_000);
    useViewerStore.setState({
      models: new Map([[modelA.id, modelA], [modelB.id, modelB]]),
      activeModelId: modelA.id,
      ifcDataStore: modelA.ifcDataStore,
      scheduleData: null,
    });

    const ui = render(<GanttPanel />);
    assert.match(ui.textContent ?? '', /Delivery plan.*Shell programme/);
    assert.match(ui.textContent ?? '', /Future works.*No nested schedules/);
    assert.match(ui.textContent ?? '', /Ungrouped: Site logistics/);
    assert.match(ui.textContent ?? '', /No scheduled tasks/);

    act(() => useViewerStore.getState().setActiveModel(modelB.id));

    assert.match(ui.textContent ?? '', /Federated fit-out plan.*No nested schedules/);
    assert.doesNotMatch(ui.textContent ?? '', /Delivery plan/);
  });

  it('distinguishes an empty selected schedule from a model with no IfcTask records (#4834)', async () => {
    const scheduledTask: ScheduleTaskInfo = {
      expressId: 0,
      globalId: 'task-fit-out',
      name: 'Install finishes',
      isMilestone: false,
      childGlobalIds: [],
      productExpressIds: [],
      productGlobalIds: [],
      controllingScheduleGlobalIds: ['schedule-populated'],
      taskTime: {
        scheduleStart: '2026-09-15T08:00:00',
        scheduleFinish: '2026-09-16T08:00:00',
      },
    };
    const emptySchedule = {
      ...control('WorkSchedule', 'schedule-empty', 'Empty first programme'),
      taskGlobalIds: [],
    };
    const populatedSchedule = {
      ...control('WorkSchedule', 'schedule-populated', 'Fit-out programme'),
      taskGlobalIds: [scheduledTask.globalId],
    };
    const store = await parseSchedule([emptySchedule, populatedSchedule], [scheduledTask]);
    const active = model('model-schedules', store, 0);
    useViewerStore.setState({
      models: new Map([[active.id, active]]),
      activeModelId: active.id,
      ifcDataStore: active.ifcDataStore,
      scheduleData: null,
    });

    const ui = render(<GanttPanel />);

    assert.match(ui.textContent ?? '', /No tasks in selected schedule/);
    assert.match(ui.textContent ?? '', /Choose All tasks/);
    assert.doesNotMatch(ui.textContent ?? '', /has no IfcTask records/);
    assert.doesNotMatch(ui.textContent ?? '', /Generate schedule/);
  });
});
