/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ScheduleCard — surface 4D / construction-schedule data in Properties.
 *
 * Two complementary views, picked automatically based on the selection:
 *   • Selected entity is a *product* controlled by one or more IfcTasks →
 *     "Construction Schedule" card listing each controlling task with its
 *     start/finish/duration and parent work-schedule name.
 *   • Selected entity is itself an IfcTask / IfcWorkSchedule (rare in
 *     practice — these typically aren't pickable in the 3D view) → show
 *     its time data directly.
 *
 * The card pulls from the viewer's `scheduleSlice` (which holds both parsed
 * and locally-generated schedules), so it lights up automatically the moment
 * the user generates a schedule via the Gantt panel — no separate fetch.
 */

import { useMemo } from 'react';
import { CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CalendarClock, Diamond, Flag, ChevronDown } from 'lucide-react';
import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import { taskProductExpressIds, taskProductGlobalIds } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { PersistentCollapsible } from './PersistentCollapsible';
import { taskStartIso, taskFinishIso, taskDurationIso } from '@/store/slices/schedule-task-dates';
import { parseIsoDate } from '@/store/slices/schedule-edit-helpers';
import { cn } from '@/lib/utils';
import { INSPECTOR_SECTION, INSPECTOR_TRIGGER, INSPECTOR_TITLE, INSPECTOR_COUNT, INSPECTOR_CHEVRON, INSPECTOR_ROWS, InspectorRow } from './inspector-ui';

interface ScheduleCardProps {
  /** Schedule data from the viewer's slice (parsed or generated). */
  scheduleData: ScheduleExtraction | null;
  /** Selected entity's local express ID. */
  selectedExpressId: number | null;
  /** Selected entity's globalId (used as a fallback when expressId === 0). */
  selectedGlobalId?: string | null;
  /**
   * When true, the schedule was created via the Gantt panel's "Generate
   * from storeys" dialog and isn't yet baked into the source IFC. We render
   * a small "Generated locally" badge so users know the schedule will be
   * spliced in on the next IFC export.
   */
  isGenerated: boolean;
}

export function ScheduleCard({
  scheduleData,
  selectedExpressId,
  selectedGlobalId,
  isGenerated,
}: ScheduleCardProps) {
  const { t, locale } = useTranslation();
  const tasks = useMemo(
    () => findControllingTasks(scheduleData, selectedExpressId, selectedGlobalId),
    [scheduleData, selectedExpressId, selectedGlobalId],
  );
  const scheduleNames = useMemo(
    () => buildScheduleNameLookup(scheduleData),
    [scheduleData],
  );

  if (tasks.length === 0) return null;

  return (
    <PersistentCollapsible
      id="schedule"
      className={INSPECTOR_SECTION}
    >
      <CollapsibleTrigger className={INSPECTOR_TRIGGER}>
        <CalendarClock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className={INSPECTOR_TITLE}>
          {t('properties.schedule.heading')}
        </span>
        {isGenerated && (
          <span
            className="flex items-center gap-1 text-2xs font-medium bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 shrink-0"
            title={t('properties.schedule.pendingTooltip')}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
            {t('properties.schedule.pendingBadge')}
          </span>
        )}
        <span className={INSPECTOR_COUNT}>
          {t('properties.schedule.taskCount', {
            count: tasks.length,
            countDisplay: formatLocaleNumber(locale, tasks.length),
          })}
        </span>
        <ChevronDown className={INSPECTOR_CHEVRON} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {isGenerated && (
          <p className="px-3 py-1.5 text-2xs text-amber-700 dark:text-amber-300">
            {t('properties.schedule.generatedLocallyNote')}
          </p>
        )}
        <div className={INSPECTOR_ROWS}>
          {tasks.map((task) => (
            <TaskRow key={task.globalId} task={task} scheduleNames={scheduleNames} locale={locale} />
          ))}
        </div>
      </CollapsibleContent>
    </PersistentCollapsible>
  );
}

interface TaskRowProps {
  task: ScheduleTaskInfo;
  scheduleNames: Map<string, string>;
  locale: string;
}

function TaskRow({ task, scheduleNames, locale }: TaskRowProps) {
  const { t } = useTranslation();
  const start = formatDate(taskStartIso(task), locale);
  const finish = formatDate(taskFinishIso(task), locale);
  const duration = taskDurationIso(task);
  const completion = task.taskTime?.completion;
  const isCritical = task.taskTime?.isCritical === true;
  const scheduleLabels = task.controllingScheduleGlobalIds
    .map(gid => scheduleNames.get(gid))
    .filter((s): s is string => Boolean(s));

  return (
    <div className="pt-1">
      <div className="flex h-6 min-w-0 items-center gap-1.5 px-3 text-xs">
        {task.isMilestone ? (
          <Diamond className="h-3 w-3 text-amber-500 fill-amber-500 shrink-0" />
        ) : isCritical ? (
          <Flag className="h-3 w-3 text-red-500 fill-red-500 shrink-0" />
        ) : null}
        <span
          className={cn('min-w-0 flex-1 truncate font-medium', isCritical ? 'text-red-600 dark:text-red-400' : 'text-foreground')}
          title={task.name}
        >
          {task.name || task.identification || task.globalId.slice(0, 12)}
        </span>
        {task.predefinedType && (
          <span className={cn(INSPECTOR_COUNT, 'pr-1 font-mono')}>{task.predefinedType}</span>
        )}
      </div>
      {start && <InspectorRow label={t('properties.schedule.start')} value={start} />}
      {finish && <InspectorRow label={t('properties.schedule.finish')} value={finish} />}
      {duration && <InspectorRow label={t('properties.schedule.duration')} value={duration} mono />}
      {completion !== undefined && (
        <InspectorRow label={t('properties.schedule.complete')} value={`${Math.round(completion)}%`} />
      )}
      {scheduleLabels.length > 0 && (
        <InspectorRow label={t('properties.schedule.schedule')} value={scheduleLabels.join(', ')} />
      )}
    </div>
  );
}

/**
 * Find all tasks whose products include the selected entity.
 *
 * Federation-aware: prefer `productGlobalIds` whenever we know the entity's
 * globalId (and the task carries globalIds of its own) — local expressIds can
 * collide across federated models, so matching by globalId first is the safe
 * default. Fall back to `productExpressIds` only for schedules that never
 * recorded globalIds (legacy / headless extraction paths).
 */
function findControllingTasks(
  data: ScheduleExtraction | null,
  selectedExpressId: number | null,
  selectedGlobalId: string | null | undefined,
): ScheduleTaskInfo[] {
  if (!data || data.tasks.length === 0) return [];
  if (selectedExpressId === null && !selectedGlobalId) return [];
  const out: ScheduleTaskInfo[] = [];
  for (const task of data.tasks) {
    const productGlobalIds = taskProductGlobalIds(task);
    const taskHasGlobalIds = productGlobalIds.some(Boolean);
    if (selectedGlobalId && taskHasGlobalIds) {
      if (productGlobalIds.includes(selectedGlobalId)) out.push(task);
      // When globalIds are the authoritative side, do NOT also match on
      // expressId — a collision across models would produce a false positive.
      continue;
    }
    if (selectedExpressId !== null && selectedExpressId > 0
        && taskProductExpressIds(task).includes(selectedExpressId)) {
      out.push(task);
    }
  }
  return out;
}

function buildScheduleNameLookup(data: ScheduleExtraction | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!data) return map;
  for (const ws of data.workSchedules) {
    if (ws.globalId && ws.name) map.set(ws.globalId, ws.name);
  }
  return map;
}

/** Parsed like the Gantt (TZ-less IfcDateTime is UTC, `parseIsoDate`), displayed in local time like its bars. */
function formatDate(iso: string | undefined, locale: string): string | undefined {
  if (!iso) return undefined;
  const t = parseIsoDate(iso);
  if (t === undefined) return iso;
  return new Date(t).toLocaleDateString(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}
