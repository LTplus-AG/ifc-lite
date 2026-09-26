/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WorkScheduleInfo } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import { formatLocaleList } from '@/i18n/intlFormat';

interface GanttWorkPlanSummaryProps {
  workSchedules: WorkScheduleInfo[];
}

interface WorkPlanGroup {
  plan: WorkScheduleInfo;
  childSchedules: WorkScheduleInfo[];
}

/**
 * Resolve both sides of the extracted IfcWorkPlan -> IfcWorkSchedule link.
 * A valid extraction populates both, but accepting either side keeps SDK-built
 * schedule data visible without inventing a second grouping model in the UI.
 */
function buildWorkPlanGroups(workSchedules: WorkScheduleInfo[]): {
  groups: WorkPlanGroup[];
  ungroupedSchedules: WorkScheduleInfo[];
} {
  const schedules = workSchedules.filter(item => item.kind === 'WorkSchedule');
  const scheduleByGlobalId = new Map(schedules.map(schedule => [schedule.globalId, schedule]));
  const groupedScheduleGlobalIds = new Set<string>();

  const groups = workSchedules
    .filter(item => item.kind === 'WorkPlan')
    .map(plan => {
      const childGlobalIds = new Set(plan.childScheduleGlobalIds ?? []);
      for (const schedule of schedules) {
        if (schedule.parentPlanGlobalId === plan.globalId) {
          childGlobalIds.add(schedule.globalId);
        }
      }

      const childSchedules: WorkScheduleInfo[] = [];
      for (const globalId of childGlobalIds) {
        const schedule = scheduleByGlobalId.get(globalId);
        if (!schedule) continue;
        childSchedules.push(schedule);
        groupedScheduleGlobalIds.add(globalId);
      }
      return { plan, childSchedules };
    });

  return {
    groups,
    ungroupedSchedules: schedules.filter(
      schedule => !groupedScheduleGlobalIds.has(schedule.globalId),
    ),
  };
}

function displayName(item: WorkScheduleInfo): string {
  return item.name || item.identification || item.globalId;
}

/**
 * Read-only hierarchy summary. IfcWorkPlan is a container, not a task control,
 * so its children are described here while the toolbar continues to filter
 * tasks exclusively by IfcWorkSchedule.
 */
export function GanttWorkPlanSummary({ workSchedules }: GanttWorkPlanSummaryProps) {
  const { t, locale } = useTranslation();
  const { groups, ungroupedSchedules } = buildWorkPlanGroups(workSchedules);
  if (groups.length === 0) return null;

  return (
    <section
      aria-label={t('schedule.workPlanSummary.ariaLabel')}
      className="border-b bg-muted/20 px-3 py-1.5 text-xs"
      data-testid="gantt-work-plan-summary"
    >
      <div className="flex items-center gap-2 overflow-x-auto">
        <span className="shrink-0 font-medium text-muted-foreground">
          {t('schedule.workPlanSummary.heading', { count: groups.length })}
        </span>
        <ul className="flex items-center gap-2">
          {groups.map(({ plan, childSchedules }) => (
            <li
              key={plan.globalId}
              className="flex shrink-0 items-center gap-1.5 rounded border bg-background px-2 py-1"
              title={t('schedule.workPlanSummary.planTitle', { globalId: plan.globalId })}
            >
              <span className="font-mono text-2xs text-muted-foreground">IfcWorkPlan</span>
              <span className="font-medium">{displayName(plan)}</span>
              <span className="text-muted-foreground" aria-label={t('schedule.workPlanSummary.nestedAriaLabel')}>
                {childSchedules.length > 0
                  ? t('schedule.workPlanSummary.schedulesList', { names: formatLocaleList(locale, childSchedules.map(displayName)) })
                  : t('schedule.workPlanSummary.noNestedSchedules')}
              </span>
            </li>
          ))}
        </ul>
        {ungroupedSchedules.length > 0 && (
          <span className="shrink-0 text-muted-foreground">
            {t('schedule.workPlanSummary.ungrouped', { names: formatLocaleList(locale, ungroupedSchedules.map(displayName)) })}
          </span>
        )}
      </div>
    </section>
  );
}
