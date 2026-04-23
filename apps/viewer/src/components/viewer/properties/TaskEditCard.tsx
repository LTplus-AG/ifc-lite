/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TaskEditCard — Inspector card that renders when a single Gantt task is
 * selected, exposing the edit fields from P1 of the schedule-editing plan.
 *
 * Scope (P1):
 *   • Identity: Name, Identification, Description, PredefinedType, Milestone
 *   • Time: Start / Finish / Duration (any-two-of-three → third is derived)
 *   • Products: count + add-from-3D-selection / remove-from-3D-selection
 *   • Delete task (cascades sequences + descendants in the slice)
 *
 * Not in P1: dependency editing, inline rename, bar-drag (those are P2/P4).
 *
 * The card is controlled: every field reads from `scheduleData` via the
 * store and writes through the slice's edit actions. Those actions push
 * snapshots onto the undo stack so every field change is reversible.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ClipboardList, ChevronDown, Diamond, Plus, Minus, Trash2, Info,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import type { ScheduleTaskInfo } from '@ifc-lite/parser';

/** IfcTaskTypeEnum values — same list as the Generate dialog. */
const TASK_TYPES: readonly string[] = [
  'CONSTRUCTION', 'INSTALLATION', 'DEMOLITION', 'DISMANTLE', 'DISPOSAL',
  'MAINTENANCE', 'LOGISTIC', 'MOVE', 'OPERATION', 'REMOVAL', 'RENOVATION',
  'ATTENDANCE', 'USERDEFINED', 'NOTDEFINED',
];

const MS_PER_DAY = 86_400_000;

interface TaskEditCardProps {
  /** Global ID of the task being edited. */
  taskGlobalId: string;
}

export const TaskEditCard = memo(function TaskEditCard({ taskGlobalId }: TaskEditCardProps) {
  // Pull the current task + sibling store actions in a single selector so
  // re-renders stay predictable.
  const {
    task,
    updateTask,
    updateTaskTime,
    assignProducts,
    unassignProducts,
    deleteTask,
    selectedEntityIds,
    scheduleIsEdited,
    scheduleUndoDepth,
  } = useViewerStore(useShallow((s) => ({
    task: s.scheduleData?.tasks.find((t) => t.globalId === taskGlobalId) ?? null,
    updateTask: s.updateTask,
    updateTaskTime: s.updateTaskTime,
    assignProducts: s.assignProductsToTask,
    unassignProducts: s.unassignProductsFromTask,
    deleteTask: s.deleteTask,
    selectedEntityIds: s.selectedEntityIds,
    scheduleIsEdited: s.scheduleIsEdited,
    scheduleUndoDepth: s.scheduleUndoStack.length,
  })));

  // Local draft for text inputs so typing doesn't round-trip through the
  // store on every keystroke. Committed on blur / Enter.
  const [nameDraft, setNameDraft] = useState<string>('');
  const [identDraft, setIdentDraft] = useState<string>('');

  // Date / duration drafts — held locally and pushed to the store after a
  // short debounce so rapid typing or picker-spinning doesn't produce a
  // per-keystroke undo snapshot + re-render storm. Committed on blur
  // immediately to make the Tab-away flow feel instant.
  const { startLocal, finishLocal, durationDays } = useMemo(
    () => deriveTimeFields(task),
    [task],
  );
  const [startDraft, setStartDraft] = useState<string>('');
  const [finishDraft, setFinishDraft] = useState<string>('');
  const [durationDraft, setDurationDraft] = useState<string>('');

  // Sync drafts from authoritative state whenever the task changes or an
  // undo/redo snaps back to a different value.
  useMemo(() => {
    setNameDraft(task?.name ?? '');
    setIdentDraft(task?.identification ?? '');
    setStartDraft(startLocal);
    setFinishDraft(finishLocal);
    setDurationDraft(durationDays === 0 ? '' : String(durationDays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskGlobalId, task?.name, task?.identification, startLocal, finishLocal, durationDays, scheduleUndoDepth]);

  // Debounce handle shared across the three time fields. Flush on unmount
  // or when the user switches tasks so no edit is silently dropped.
  const timeCommitRef = useRef<{ timer: number | null; flush: (() => void) | null }>({ timer: null, flush: null });
  useEffect(() => {
    return () => {
      if (timeCommitRef.current.timer !== null) {
        window.clearTimeout(timeCommitRef.current.timer);
        timeCommitRef.current.flush?.();
        timeCommitRef.current.timer = null;
        timeCommitRef.current.flush = null;
      }
    };
  }, [taskGlobalId]);

  const scheduleTimeCommit = useCallback((flush: () => void) => {
    if (timeCommitRef.current.timer !== null) {
      window.clearTimeout(timeCommitRef.current.timer);
    }
    timeCommitRef.current.flush = flush;
    timeCommitRef.current.timer = window.setTimeout(() => {
      timeCommitRef.current.flush?.();
      timeCommitRef.current.timer = null;
      timeCommitRef.current.flush = null;
    }, 200);
  }, []);

  const flushTimeCommit = useCallback(() => {
    if (timeCommitRef.current.timer !== null) {
      window.clearTimeout(timeCommitRef.current.timer);
      timeCommitRef.current.flush?.();
      timeCommitRef.current.timer = null;
      timeCommitRef.current.flush = null;
    }
  }, []);

  const [showDetails, setShowDetails] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const onCommitName = useCallback(() => {
    if (task && nameDraft !== task.name) updateTask(taskGlobalId, { name: nameDraft });
  }, [nameDraft, task, taskGlobalId, updateTask]);

  const onCommitIdentification = useCallback(() => {
    if (task && identDraft !== (task.identification ?? '')) {
      updateTask(taskGlobalId, { identification: identDraft || undefined });
    }
  }, [identDraft, task, taskGlobalId, updateTask]);

  if (!task) return null;

  // Product assignment buttons act on whatever the user has selected in
  // the 3D viewport. Gated when that set is empty.
  const viewport3DCount = selectedEntityIds.size;

  return (
    <Collapsible
      defaultOpen
      className="border-2 border-primary/40 bg-primary/5 w-full max-w-full overflow-hidden"
    >
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-primary/10 text-left transition-colors overflow-hidden">
        <ClipboardList className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="font-bold text-xs text-primary truncate flex-1 min-w-0">
          Edit task
        </span>
        {scheduleIsEdited && (
          <span className="text-[10px] font-medium bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 shrink-0">
            ● Pending
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-t-2 border-primary/40 p-3 grid gap-3">
          {/* Identity */}
          <div className="grid gap-1.5">
            <Label htmlFor="task-name" className="text-[11px]">Name</Label>
            <Input
              id="task-name"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={onCommitName}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
              placeholder="Untitled task"
              className="h-8 text-sm"
            />
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="task-type" className="text-[11px]">Predefined type</Label>
              <Select
                value={task.predefinedType || 'NOTDEFINED'}
                onValueChange={(v) => updateTask(taskGlobalId, { predefinedType: v })}
              >
                <SelectTrigger id="task-type" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ToggleRow
              label="Milestone"
              icon={<Diamond className="h-3 w-3" />}
              checked={task.isMilestone}
              onChange={(v) => updateTask(taskGlobalId, { isMilestone: v })}
            />
          </div>

          {/* Time — stacked layout. Two datetime-local inputs side-by-side
              overflow the narrow default Inspector width (22 % of viewport);
              stacking reads cleaner even at wide widths and gives every
              input enough room to render the browser's picker UI. */}
          <div className="grid gap-2 rounded border border-border/60 p-2">
            <div className="grid gap-1">
              <Label htmlFor="task-start" className="text-[10px]">Start</Label>
              <Input
                id="task-start"
                type="datetime-local"
                value={startDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setStartDraft(v);
                  scheduleTimeCommit(() => {
                    updateTaskTime(taskGlobalId, {
                      scheduleStart: v ? `${v}:00` : undefined,
                    });
                  });
                }}
                onBlur={flushTimeCommit}
                className="h-7 w-full text-xs font-mono"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="task-finish" className="text-[10px]">Finish</Label>
              <Input
                id="task-finish"
                type="datetime-local"
                value={finishDraft}
                disabled={task.isMilestone}
                onChange={(e) => {
                  const v = e.target.value;
                  setFinishDraft(v);
                  scheduleTimeCommit(() => {
                    updateTaskTime(taskGlobalId, {
                      scheduleFinish: v ? `${v}:00` : undefined,
                    });
                  });
                }}
                onBlur={flushTimeCommit}
                className="h-7 w-full text-xs font-mono"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="task-dur" className="text-[10px]">Duration (days)</Label>
              <Input
                id="task-dur"
                type="number"
                min={0}
                step={0.5}
                value={durationDraft}
                disabled={task.isMilestone}
                onChange={(e) => {
                  const v = e.target.value;
                  setDurationDraft(v);
                  const n = parseFloat(v);
                  if (!Number.isFinite(n) || n < 0) return;
                  const iso = daysToIso(n);
                  scheduleTimeCommit(() => {
                    updateTaskTime(taskGlobalId, { scheduleDuration: iso });
                  });
                }}
                onBlur={flushTimeCommit}
                className="h-7 w-full text-xs font-mono"
              />
              <p className="text-[10px] text-muted-foreground flex items-start gap-1">
                <Info className="h-3 w-3 shrink-0 mt-px" />
                Editing start or duration keeps finish consistent; editing finish keeps start consistent.
              </p>
            </div>
          </div>

          {/* Products */}
          <div className="grid gap-2 rounded border border-border/60 p-2">
            <div className="flex items-center justify-between">
              <Label className="text-[11px]">Products</Label>
              <span className="text-[11px] font-mono text-muted-foreground">
                {task.productExpressIds.length} assigned
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => assignProducts(taskGlobalId, Array.from(selectedEntityIds))}
                    disabled={viewport3DCount === 0}
                    className="gap-1 h-7 text-xs"
                  >
                    <Plus className="h-3 w-3" />
                    Add {viewport3DCount > 0 ? `(${viewport3DCount})` : ''}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {viewport3DCount > 0
                    ? `Add the ${viewport3DCount} object(s) currently selected in the 3D viewport to this task.`
                    : 'Select objects in the 3D viewport first.'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => unassignProducts(taskGlobalId, Array.from(selectedEntityIds))}
                    disabled={viewport3DCount === 0}
                    className="gap-1 h-7 text-xs"
                  >
                    <Minus className="h-3 w-3" />
                    Remove {viewport3DCount > 0 ? `(${viewport3DCount})` : ''}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Remove the selected 3D objects from this task.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Details (identification + description) behind disclosure */}
          <button
            type="button"
            onClick={() => setShowDetails((s) => !s)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${showDetails ? '' : '-rotate-90'}`} />
            Details
          </button>
          {showDetails && (
            <div className="grid gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="task-ident" className="text-[11px]">Identification</Label>
                <Input
                  id="task-ident"
                  value={identDraft}
                  onChange={(e) => setIdentDraft(e.target.value)}
                  onBlur={onCommitIdentification}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
                  placeholder="—"
                  className="h-7 text-xs font-mono"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-[11px]">Global ID</Label>
                <div className="text-[10px] font-mono text-muted-foreground truncate" title={task.globalId}>
                  {task.globalId}
                </div>
              </div>
            </div>
          )}

          {/* Delete */}
          <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/40">
            {!confirmDelete ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                className="gap-1 h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3 w-3" />
                Delete task
              </Button>
            ) : (
              <>
                <span className="text-[11px] text-muted-foreground">Delete{task.childGlobalIds.length > 0 ? ` + ${task.childGlobalIds.length} descendants` : ''}?</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(false)}
                  className="h-7 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    deleteTask(taskGlobalId);
                    setConfirmDelete(false);
                  }}
                  className="h-7 text-xs"
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Helpers (date / duration formatting for the HTML `datetime-local` input)
// ═══════════════════════════════════════════════════════════════════════

interface DerivedTimeFields {
  /** yyyy-MM-ddTHH:mm for `<input type=datetime-local>` — empty if unset. */
  startLocal: string;
  finishLocal: string;
  /** Days as a float; 0 when no taskTime exists. */
  durationDays: number;
}

function deriveTimeFields(task: ScheduleTaskInfo | null): DerivedTimeFields {
  if (!task?.taskTime) return { startLocal: '', finishLocal: '', durationDays: 0 };
  const startLocal = toDatetimeLocal(task.taskTime.scheduleStart);
  const finishLocal = toDatetimeLocal(task.taskTime.scheduleFinish);
  let durationDays = 0;
  const start = parseIso(task.taskTime.scheduleStart);
  const finish = parseIso(task.taskTime.scheduleFinish);
  if (start !== undefined && finish !== undefined) {
    durationDays = Math.round(((finish - start) / MS_PER_DAY) * 100) / 100;
  } else if (task.taskTime.scheduleDuration) {
    durationDays = isoDurationToDays(task.taskTime.scheduleDuration);
  }
  return { startLocal, finishLocal, durationDays };
}

/** ISO-8601 → `datetime-local` string (strips seconds and any TZ). */
function toDatetimeLocal(iso?: string): string {
  if (!iso) return '';
  // Accept both `2024-05-01T08:00:00` and `2024-05-01T08:00:00Z`; the
  // `<input type=datetime-local>` doesn't take TZ info, so we just
  // trim whatever's past the minute segment.
  const trimmed = iso.replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
  return trimmed.slice(0, 16);
}

function parseIso(iso?: string): number | undefined {
  if (!iso) return undefined;
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(iso);
  const t = Date.parse(hasTz ? iso : `${iso}Z`);
  return Number.isNaN(t) ? undefined : t;
}

function isoDurationToDays(iso: string): number {
  const match = iso.match(
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return 0;
  const [, y, mo, w, d, h, mi, s] = match;
  const days =
    (y ? parseFloat(y) * 365.2425 : 0) +
    (mo ? parseFloat(mo) * 30.4369 : 0) +
    (w ? parseFloat(w) * 7 : 0) +
    (d ? parseFloat(d) : 0) +
    (h ? parseFloat(h) / 24 : 0) +
    (mi ? parseFloat(mi) / 1440 : 0) +
    (s ? parseFloat(s) / 86_400 : 0);
  return Math.round(days * 100) / 100;
}

function daysToIso(days: number): string {
  if (days === 0) return 'PT0S';
  const wholeDays = Math.floor(days);
  const fractionalMs = Math.round((days - wholeDays) * MS_PER_DAY);
  const hours = Math.floor(fractionalMs / 3_600_000);
  const mins = Math.floor((fractionalMs - hours * 3_600_000) / 60_000);
  let out = 'P';
  if (wholeDays > 0) out += `${wholeDays}D`;
  if (hours > 0 || mins > 0) {
    out += 'T';
    if (hours > 0) out += `${hours}H`;
    if (mins > 0) out += `${mins}M`;
  }
  return out === 'P' ? 'P0D' : out;
}

// ═══════════════════════════════════════════════════════════════════════
// ToggleRow — tiny labelled switch. Kept local to avoid leaking into the
// shared ui/ toolkit until we need it elsewhere.
// ═══════════════════════════════════════════════════════════════════════

interface ToggleRowProps {
  label: string;
  icon?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function ToggleRow({ label, icon, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer select-none">
      {icon && <span className="text-muted-foreground">{icon}</span>}
      <span className="text-[11px] font-medium">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
