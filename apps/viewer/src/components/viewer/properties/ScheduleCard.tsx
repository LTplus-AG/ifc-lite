/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ScheduleCard — surface 4D / construction-schedule data in the Inspector.
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CalendarClock, Diamond, Flag } from 'lucide-react';
import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';

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
    <Collapsible
      defaultOpen
      className="border-2 border-sky-200 dark:border-sky-800 bg-sky-50/20 dark:bg-sky-950/20 w-full max-w-full overflow-hidden"
    >
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-sky-50 dark:hover:bg-sky-900/30 text-left transition-colors overflow-hidden">
        <CalendarClock className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
        <span className="font-bold text-xs text-sky-700 dark:text-sky-400 truncate flex-1 min-w-0">
          Construction Schedule
        </span>
        {isGenerated && (
          <span
            className="flex items-center gap-1 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 shrink-0"
            title="Pending schedule edits — included on IFC export"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
            Pending
          </span>
        )}
        <span className="text-[10px] font-mono bg-sky-100 dark:bg-sky-900/50 px-1.5 py-0.5 border border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300 shrink-0">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-sky-200 dark:border-sky-800">
          {isGenerated && (
            <div className="px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300 bg-amber-50/80 dark:bg-amber-900/20 border-b border-amber-200/60 dark:border-amber-800/50">
              Generated locally — will be spliced into the next IFC export.
            </div>
          )}
          <div className="divide-y divide-sky-100 dark:divide-sky-900/30">
            {tasks.map((task) => (
              <TaskRow key={task.globalId} task={task} scheduleNames={scheduleNames} />
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface TaskRowProps {
  task: ScheduleTaskInfo;
  scheduleNames: Map<string, string>;
}

function TaskRow({ task, scheduleNames }: TaskRowProps) {
  const start = formatDate(task.taskTime?.scheduleStart);
  const finish = formatDate(task.taskTime?.scheduleFinish);
  const duration = task.taskTime?.scheduleDuration;
  const completion = task.taskTime?.completion;
  const isCritical = task.taskTime?.isCritical === true;
  const scheduleLabels = task.controllingScheduleGlobalIds
    .map(gid => scheduleNames.get(gid))
    .filter((s): s is string => Boolean(s));

  return (
    <div className="px-3 py-2 text-xs hover:bg-sky-50/50 dark:hover:bg-sky-900/20">
      <div className="flex items-center gap-1.5 mb-1">
        {task.isMilestone ? (
          <Diamond className="h-3 w-3 text-amber-500 fill-amber-500 shrink-0" />
        ) : isCritical ? (
          <Flag className="h-3 w-3 text-red-500 fill-red-500 shrink-0" />
        ) : null}
        <span
          className={
            'font-medium text-foreground truncate ' + (isCritical ? 'text-red-600 dark:text-red-400' : '')
          }
          title={task.name}
        >
          {task.name || task.identification || task.globalId.slice(0, 12)}
        </span>
        {task.predefinedType && (
          <span className="text-[9px] font-mono bg-sky-100 dark:bg-sky-900/50 px-1 py-0.5 border border-sky-200 dark:border-sky-800 text-sky-600 dark:text-sky-300 shrink-0">
            {task.predefinedType}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[minmax(60px,auto)_1fr] gap-x-2 gap-y-0.5 ml-1 text-[11px]">
        {start && (
          <>
            <span className="text-muted-foreground">Start</span>
            <span className="font-mono text-foreground/90">{start}</span>
          </>
        )}
        {finish && (
          <>
            <span className="text-muted-foreground">Finish</span>
            <span className="font-mono text-foreground/90">{finish}</span>
          </>
        )}
        {duration && (
          <>
            <span className="text-muted-foreground">Duration</span>
            <span className="font-mono text-foreground/90">{duration}</span>
          </>
        )}
        {completion !== undefined && (
          <>
            <span className="text-muted-foreground">Complete</span>
            <span className="font-mono text-foreground/90">{Math.round(completion)}%</span>
          </>
        )}
        {scheduleLabels.length > 0 && (
          <>
            <span className="text-muted-foreground">Schedule</span>
            <span className="text-foreground/90 truncate" title={scheduleLabels.join(', ')}>
              {scheduleLabels.join(', ')}
            </span>
          </>
        )}
      </div>
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
    const taskHasGlobalIds = task.productGlobalIds.some(Boolean);
    if (selectedGlobalId && taskHasGlobalIds) {
      if (task.productGlobalIds.includes(selectedGlobalId)) out.push(task);
      // When globalIds are the authoritative side, do NOT also match on
      // expressId — a collision across models would produce a false positive.
      continue;
    }
    if (selectedExpressId !== null && selectedExpressId > 0
        && task.productExpressIds.includes(selectedExpressId)) {
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

function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}
