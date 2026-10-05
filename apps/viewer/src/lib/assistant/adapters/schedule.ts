/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 4D schedule shown in the Gantt panel as evidence (#6833): one row per
 * IfcTask with its resolved window (the canonical `schedule-task-dates`
 * precedence the bars use), milestone flag, parent and assigned products.
 */

import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import { taskProductExpressIds, taskProductGlobalIds } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { taskFinishIso, taskStartIso } from '@/store/slices/schedule-task-dates';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const PRODUCT_SAMPLE = 10;

/** Tasks carrying an IFC expressId exist in the host file; the rest were authored in this session. */
function fromFile(task: ScheduleTaskInfo): boolean {
  return task.expressId > 0;
}

function taskRow(s: ViewerState, task: ScheduleTaskInfo) {
  const products = taskProductGlobalIds(task);
  const start = taskStartIso(task) ?? null;
  const finish = taskFinishIso(task) ?? null;
  return evidenceRow({
    kind: 'scheduleTask', modelId: s.scheduleSourceModelId,
    globalId: task.globalId, expressId: fromFile(task) ? task.expressId : null,
    status: task.status ?? null,
  }, {
    name: task.name, identification: task.identification ?? null, predefinedType: task.predefinedType ?? null,
    start, finish, datesAvailable: start !== null || finish !== null,
    isMilestone: task.isMilestone, isCritical: task.taskTime?.isCritical ?? null,
    completion: task.taskTime?.completion ?? null,
    parentGlobalId: task.parentGlobalId ?? null, childCount: task.childGlobalIds.length,
    productCount: taskProductExpressIds(task).length,
    inputProductCount: task.productExpressIds.length, outputProductCount: task.outputProductExpressIds?.length ?? 0,
    productGlobalIds: products.slice(0, PRODUCT_SAMPLE), productGlobalIdsSampled: products.length > PRODUCT_SAMPLE,
    workScheduleGlobalIds: task.controllingScheduleGlobalIds,
    provenance: fromFile(task) ? 'ifc-file' : 'session-authored',
  });
}

function summarize(s: ViewerState, data: ScheduleExtraction) {
  const range = s.scheduleRange;
  let milestones = 0, withoutDates = 0, inFile = 0;
  for (const task of data.tasks) {
    if (task.isMilestone) milestones++;
    if (!taskStartIso(task) && !taskFinishIso(task)) withoutDates++;
    if (fromFile(task)) inFile++;
  }
  const authored = data.tasks.length - inFile;
  return {
    kind: 'schedule',
    workSchedules: data.workSchedules.slice(0, 50).map(schedule => ({ globalId: schedule.globalId, kind: schedule.kind,
      name: schedule.name, rootTaskCount: schedule.taskGlobalIds.length })),
    workScheduleCount: data.workSchedules.length,
    activeWorkScheduleFilter: s.activeWorkScheduleId || null,
    taskCount: data.tasks.length, milestoneCount: milestones, tasksWithoutDates: withoutDates,
    sequenceCount: data.sequences.length, calendarCount: data.workCalendars?.length ?? 0,
    dateRange: range && !range.synthetic ? { start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() } : null,
    dateRangeNote: !range ? 'No tasks, so no date range.'
      : range.synthetic ? 'No task carries a date; the Gantt shows a synthetic window, which is not reported.' : null,
    units: { dates: 'ISO 8601 as written in the IFC task time; a finish derived from start plus duration is UTC.' },
    provenance: {
      tasksFromIfcFile: inFile, tasksAuthoredInSession: authored,
      sessionAuthoredOrigin: authored > 0 ? 'generated or imported; the viewer does not record which' : null,
      editedSinceLoad: s.scheduleIsEdited, sourceModelId: s.scheduleSourceModelId,
    },
    limitations: 'Rows cover every task, not only the Gantt\'s active work-schedule filter. '
      + 'Dates are planned or actual values, falling back to early (CPM) dates only when a task has neither; a null date was not recorded. '
      + 'Product lists are sampled to the first 10 GlobalIds; productCount is the full number. '
      + 'The schedule is what the Gantt panel last extracted for the active model; tasks of other loaded models are not included.',
  };
}

export const scheduleAdapter: EvidenceAdapter = {
  id: 'schedule', group: 'coordination', panelIds: ['gantt'],
  titleKey: 'workspacePanels.bottom.gantt', descriptionKey: 'assistantSources.schedule.description',
  rowMeaningKey: 'assistantSources.schedule.rows', unavailableKey: 'assistantSources.schedule.unavailable',
  suggestionKeys: ['assistantSources.schedule.suggestSummary', 'assistantSources.schedule.suggestGaps'],
  readiness: s => s.scheduleData
    ? { status: { labelKey: 'assistantSources.schedule.ready', params: { count: s.scheduleData.tasks.length } }, ready: true }
    : { status: { labelKey: 'assistantSources.schedule.none' }, ready: false },
  // Every schedule edit, extraction, generation and import replaces the extraction object.
  identity: s => s.scheduleData,
  capture: (s, limit) => {
    const data = s.scheduleData;
    if (!data) return unavailableCapture();
    return {
      summary: summarize(s, data),
      rows: data.tasks.slice(0, limit).map(task => taskRow(s, task)),
      totalRows: data.tasks.length, availability: 'available',
    };
  },
};
