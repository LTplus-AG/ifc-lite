/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place a task's time window is resolved from its IfcTaskTime
 * (#6803). The Gantt bars, the schedule range, the 4D animator, the charts
 * dataset, the Properties schedule card, bar drag and add-task anchoring
 * all read through here; three diverged copies used to live in those
 * modules.
 *
 * Precedence:
 *   1. The planned/as-built window: ScheduleStart ?? ActualStart, and
 *      ScheduleFinish ?? ActualFinish ?? start + (ScheduleDuration ??
 *      ActualDuration). Unchanged from before #6803.
 *   2. Only when the task has none of those four dates, the CPM window:
 *      EarlyStart, and EarlyFinish ?? EarlyStart + ScheduleDuration.
 *      buildingSMART's construction-scheduling sample writes leaf tasks
 *      this way (ScheduleStart/ScheduleFinish `$`). Gating on "no planned
 *      or actual date at all" keeps every file that has one byte-identical
 *      and never mixes a planned start with an early finish.
 *
 * Pure, and free of `@/store` imports: the animator imports this module,
 * and `scheduleSlice` imports the animator, so routing it through the
 * store barrel would reintroduce the ESM initialisation cycle the
 * animator's old local copy existed to dodge.
 */

import type { ScheduleTaskInfo, ScheduleTaskTimeInfo } from '@ifc-lite/parser';
import { parseIsoDate, toIsoUtc } from './schedule-edit-helpers.js';

type TaskLike = Pick<ScheduleTaskInfo, 'taskTime'>;

/** True when the task carries any planned or as-built date. */
function hasPlannedOrActual(tt: ScheduleTaskTimeInfo): boolean {
  return Boolean(tt.scheduleStart || tt.actualStart || tt.scheduleFinish || tt.actualFinish);
}

/** The start ISO string the window is anchored on, as written in the file. */
export function taskStartIso(task: TaskLike): string | undefined {
  const tt = task.taskTime;
  if (!tt) return undefined;
  return hasPlannedOrActual(tt) ? (tt.scheduleStart ?? tt.actualStart) : tt.earlyStart;
}

/** The explicit finish ISO string, as written in the file (no duration fallback). */
export function taskExplicitFinishIso(task: TaskLike): string | undefined {
  const tt = task.taskTime;
  if (!tt) return undefined;
  return hasPlannedOrActual(tt) ? (tt.scheduleFinish ?? tt.actualFinish) : tt.earlyFinish;
}

/** The duration paired with the resolved start, for the finish fallback and display. */
export function taskDurationIso(task: TaskLike): string | undefined {
  const tt = task.taskTime;
  if (!tt) return undefined;
  return hasPlannedOrActual(tt) ? (tt.scheduleDuration ?? tt.actualDuration) : tt.scheduleDuration;
}

export function taskStartEpoch(task: TaskLike): number | undefined {
  return parseIsoDate(taskStartIso(task));
}

/**
 * The finish epoch: the explicit finish when present, otherwise start plus
 * the paired duration, otherwise the start itself. Undefined only when the
 * task has neither a finish nor a start.
 */
export function taskFinishEpoch(task: TaskLike): number | undefined {
  const finish = parseIsoDate(taskExplicitFinishIso(task));
  if (finish !== undefined) return finish;
  const start = taskStartEpoch(task);
  if (start === undefined) return undefined;
  const duration = taskDurationIso(task);
  if (!duration) return start;
  const match = duration.match(
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return start;
  const [, y, mo, w, d, h, mi, s] = match;
  const yearMs = 365.2425 * 86400_000;
  const monthMs = yearMs / 12;
  const totalMs =
    (y ? parseFloat(y) * yearMs : 0) +
    (mo ? parseFloat(mo) * monthMs : 0) +
    (w ? parseFloat(w) * 7 * 86400_000 : 0) +
    (d ? parseFloat(d) * 86400_000 : 0) +
    (h ? parseFloat(h) * 3_600_000 : 0) +
    (mi ? parseFloat(mi) * 60_000 : 0) +
    (s ? parseFloat(s) * 1000 : 0);
  return start + totalMs;
}

/**
 * The base an edit to ScheduleStart/ScheduleFinish/ScheduleDuration merges
 * onto. An early-only task gets its CPM window copied into the planned
 * fields first: the first planned date written flips resolution to the
 * planned window, so without this, editing only the finish would leave a
 * task with no start and the bar would vanish.
 */
export function plannedEditBase(tt: ScheduleTaskTimeInfo | undefined): ScheduleTaskTimeInfo {
  if (!tt) return {};
  if (hasPlannedOrActual(tt) || !tt.earlyStart) return tt;
  return { ...tt, scheduleStart: tt.earlyStart, scheduleFinish: tt.earlyFinish };
}

/** The finish as an ISO string: as written when explicit, else derived (UTC). */
export function taskFinishIso(task: TaskLike): string | undefined {
  const explicit = taskExplicitFinishIso(task);
  if (explicit) return explicit;
  const finish = taskFinishEpoch(task);
  return finish === undefined ? undefined : toIsoUtc(finish);
}
