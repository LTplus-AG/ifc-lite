/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ScheduleExtraction } from '@ifc-lite/parser';
import { buildWorkPlanInfo } from '@/components/viewer/schedule/schedule-utils';
/** The Generate dialog and operation compose the same optional native work plan. */
export function generatedExtraction(extraction: ScheduleExtraction, workPlanName: string | null): ScheduleExtraction {
  return workPlanName === null ? extraction : { ...extraction, workSchedules: [...extraction.workSchedules,
    buildWorkPlanInfo(extraction.workSchedules[0]?.globalId ?? 'workplan', workPlanName, extraction.workSchedules.map(schedule => schedule.globalId))] };
}
