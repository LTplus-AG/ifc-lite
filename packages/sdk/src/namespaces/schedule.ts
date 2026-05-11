/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.schedule — read-only access to IFC 4D scheduling data.
 *
 * Mirrors the data the parser's `extractScheduleOnDemand` produces:
 *   • `data()`            — the full extraction (tasks + sequences + schedules)
 *   • `tasks()`           — flat task list
 *   • `workSchedules()`   — IfcWorkSchedule / IfcWorkPlan containers
 *   • `sequences()`       — IfcRelSequence edges (FS/SS/FF/SF with optional lag)
 *
 * The `modelId` argument is optional. When omitted, the active model is used.
 */

import type {
  BimBackend,
  ScheduleExtractionData,
  ScheduleTaskData,
  WorkScheduleData,
  ScheduleSequenceData,
} from '../types.js';

export class ScheduleNamespace {
  constructor(private backend: BimBackend) {}

  /** Full schedule extraction for the active (or specified) model. */
  data(modelId?: string): ScheduleExtractionData {
    return this.backend.schedule.data(modelId);
  }

  /** Flat task list — convenience wrapper around `data().tasks`. */
  tasks(modelId?: string): ScheduleTaskData[] {
    return this.backend.schedule.tasks(modelId);
  }

  /** All IfcWorkSchedule / IfcWorkPlan containers in the model. */
  workSchedules(modelId?: string): WorkScheduleData[] {
    return this.backend.schedule.workSchedules(modelId);
  }

  /** All IfcRelSequence dependency edges in the model. */
  sequences(modelId?: string): ScheduleSequenceData[] {
    return this.backend.schedule.sequences(modelId);
  }
}
