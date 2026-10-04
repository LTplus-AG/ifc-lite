/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `schedule` chart dataset (#3944): one row per task of the active
 * schedule, its products' renderer ids on the row. `Phase` is the task's
 * state at the playback cursor (not started / in progress / done), so a
 * chart of it follows the 4D playback; `Start` / `Finish` are date columns
 * for a per-week timeline.
 *
 * Products are attributed to the schedule's source model, exactly as the
 * Gantt's own 3D highlight does (`schedule-selection.ts`).
 */
import type { ChartDataset, ChartDatasetColumn, ChartDatasetRow } from '@ifc-lite/charts';
import type { ScheduleTaskInfo } from '@ifc-lite/parser';
import { taskProductExpressIds } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { taskStartEpoch, taskFinishEpoch, taskStartIso, taskFinishIso } from '@/store/slices/schedule-task-dates';

export const SCHEDULE_COLUMNS = {
  task: 'Task',
  status: 'Status',
  phase: 'Phase',
  type: 'TaskType',
  critical: 'Critical',
  milestone: 'Milestone',
  start: 'Start',
  finish: 'Finish',
  durationDays: 'DurationDays',
  products: 'Products',
} as const;

export const SCHEDULE_DATASET_COLUMNS: ChartDatasetColumn[] = [
  { id: SCHEDULE_COLUMNS.task, label: 'Task', kind: 'category' },
  { id: SCHEDULE_COLUMNS.status, label: 'Status', kind: 'category' },
  { id: SCHEDULE_COLUMNS.phase, label: 'Phase at cursor', kind: 'category' },
  { id: SCHEDULE_COLUMNS.type, label: 'Task type', kind: 'category' },
  { id: SCHEDULE_COLUMNS.critical, label: 'Critical', kind: 'boolean' },
  { id: SCHEDULE_COLUMNS.milestone, label: 'Milestone', kind: 'boolean' },
  { id: SCHEDULE_COLUMNS.start, label: 'Start', kind: 'date' },
  { id: SCHEDULE_COLUMNS.finish, label: 'Finish', kind: 'date' },
  { id: SCHEDULE_COLUMNS.durationDays, label: 'Duration', kind: 'number', unit: 'days' },
  { id: SCHEDULE_COLUMNS.products, label: 'Products', kind: 'number' },
];

const MS_PER_DAY = 86_400_000;

/** The task's lifecycle state at `time`, from its resolved window (`schedule-task-dates.ts`). */
export function phaseAt(task: ScheduleTaskInfo, time: number | null): string {
  const start = taskStartEpoch(task);
  const finish = taskFinishEpoch(task);
  if (start === undefined || finish === undefined) return 'unscheduled';
  if (time === null) return 'scheduled';
  if (time < start) return 'not started';
  if (time > finish) return 'done';
  return 'in progress';
}

export type ScheduleDatasetState = Pick<ViewerState, 'scheduleData' | 'scheduleSourceModelId' | 'activeModelId' | 'models' | 'playbackTime' | 'animationEnabled'>;

export function buildScheduleDataset(state: ScheduleDatasetState): ChartDataset {
  const rows: ChartDatasetRow[] = [];
  const tasks = state.scheduleData?.tasks ?? [];
  const modelId = state.scheduleSourceModelId ?? state.activeModelId ?? 'legacy';
  const cursor = state.animationEnabled ? state.playbackTime : null;
  for (const task of tasks) {
    const start = taskStartEpoch(task);
    const finish = taskFinishEpoch(task);
    // A product can be both an input and an output of one task; count it once.
    const productIds = [...new Set(taskProductExpressIds(task))];
    rows.push({
      ids: productIds.map((id) => toGlobalIdFromModels(state.models, modelId, id)),
      values: [
        task.name,
        task.status ?? '',
        phaseAt(task, cursor),
        task.predefinedType ?? '',
        task.taskTime?.isCritical ?? false,
        task.isMilestone,
        taskStartIso(task) ?? null,
        taskFinishIso(task) ?? null,
        start !== undefined && finish !== undefined ? Math.max(0, (finish - start) / MS_PER_DAY) : null,
        productIds.length,
      ],
    });
  }
  return { source: 'schedule', columns: SCHEDULE_DATASET_COLUMNS, rows, fingerprint: `schedule:${modelId}:${rows.length}:${cursor ?? 'off'}` };
}
