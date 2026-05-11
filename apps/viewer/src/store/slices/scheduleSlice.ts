/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schedule state slice — IFC 4D / IfcTask Gantt panel + playback animation.
 *
 * The slice holds:
 *   • extracted schedule data (tasks, sequences, work schedules)
 *   • UI state (panel visibility, selected work schedule, expanded rows)
 *   • playback state (current time, speed, isPlaying)
 *   • derived-set caches that wire into the 3D viewport's hidden-entity set
 *     during animation (written through `visibilitySlice.hiddenEntities`).
 *
 * Time is stored as an epoch-millisecond number. When the schedule lacks real
 * dates we fall back to a synthetic range (day 0 … sum-of-durations).
 */

import type { StateCreator } from 'zustand';
import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import { deterministicGlobalId } from '@ifc-lite/parser';
import {
  parseIsoDate,
  msToIsoDuration,
  addIsoDurationToEpoch,
  toIsoUtc,
  isoNowAt8,
  reconcileTaskTime,
  cloneExtraction,
  resolveSingleModelId,
  resolveIdOffset,
} from './schedule-edit-helpers.js';

export type GanttTimeScale = 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * Undo / redo entry — discriminated union with two kinds:
 *
 *   • `kind: 'full'` — captures the entire `scheduleData` as a deep clone.
 *     Used by structural edits (add / delete / move / assign / unassign)
 *     and by transaction-begin, where the set of affected fields is
 *     hard to bound ahead of time.
 *
 *   • `kind: 'fieldPatch'` — captures only the before-state of the fields
 *     that changed on a single task. Used by `updateTask` and
 *     `updateTaskTime` (the common case — typing a name, dragging a bar).
 *     ~100 bytes per entry vs ~20 KB for a full clone of a 500-task
 *     schedule, which matters at the 50-entry stack cap.
 *
 * `label` surfaces in the UI toast so users see "Undone: edit task
 * name" rather than a generic message. `priorRange` + `priorIsEdited`
 * are captured on both kinds so undo restores derived state + the
 * pending-edit flag correctly (recomputing is cheap but doesn't tell
 * us whether the schedule was "clean" before the edit — an edit sequence
 * could span crossings of that flag).
 */
export interface ScheduleFullSnapshot {
  kind: 'full';
  label: string;
  data: ScheduleExtraction | null;
  range: ScheduleTimeRange | null;
  isEdited: boolean;
}

export interface ScheduleFieldPatchSnapshot {
  kind: 'fieldPatch';
  label: string;
  taskGlobalId: string;
  /** Fields on the task as they were BEFORE the edit. Sparse. */
  before: Partial<ScheduleTaskInfo>;
  /** Range before the edit — restored verbatim on undo. */
  priorRange: ScheduleTimeRange | null;
  /** `scheduleIsEdited` flag before the edit. */
  priorIsEdited: boolean;
}

export type ScheduleSnapshot = ScheduleFullSnapshot | ScheduleFieldPatchSnapshot;

export interface ScheduleTimeRange {
  /** Earliest task start time, epoch ms. */
  start: number;
  /** Latest task finish time, epoch ms. */
  end: number;
  /** true when task dates were synthesized from durations (no ScheduleStart values). */
  synthetic: boolean;
}

export interface ScheduleSlice {
  // ── Data ──────────────────────────────────────────────
  /** Extracted schedule data for the currently loaded model(s). */
  scheduleData: ScheduleExtraction | null;
  /** Pre-computed min/max date range across all tasks with dates. */
  scheduleRange: ScheduleTimeRange | null;
  /** Currently focused work schedule globalId ('' = show all tasks). */
  activeWorkScheduleId: string;

  // ── Panel UI ──────────────────────────────────────────
  ganttPanelVisible: boolean;
  /**
   * Generate-schedule-from-storeys dialog open flag. Lives in the slice (not
   * local component state) so the command palette and other entry points can
   * open it without coupling to GanttPanel's render tree.
   */
  generateScheduleDialogOpen: boolean;
  /** globalIds of expanded rows in the task tree. */
  expandedTaskGlobalIds: Set<string>;
  /** globalId currently hovered in the Gantt timeline. */
  hoveredTaskGlobalId: string | null;
  /** globalIds currently selected in the Gantt (separate from viewport selection). */
  selectedTaskGlobalIds: Set<string>;
  /** Timeline zoom scale. */
  ganttTimeScale: GanttTimeScale;

  /**
   * Model the current `scheduleData` is attributed to, for federation +
   * dirty-tracking integration. Set by `commitGeneratedSchedule` when the
   * user generates a schedule from the spatial hierarchy; remains null
   * when the schedule came from extraction (extracted tasks already exist
   * in the host STEP file and aren't "pending").
   */
  scheduleSourceModelId: string | null;

  /**
   * True when any schedule edit (updateTask / updateTaskTime / assign /
   * unassign / deleteTask / sequence mutation) has diverged the in-memory
   * `scheduleData` from whatever the host STEP file currently has on disk.
   *
   * When set, the export path rewrites the entire schedule block (strips
   * the original entities, re-emits from `scheduleData`). Cheaper than
   * per-entity diffing and eliminates whole classes of dangling-reference
   * bugs when dependent entities (`IfcTaskTime`, `IfcLagTime`, `IfcRel*`)
   * cascade on task deletion.
   *
   * Distinct from "has generated tasks" (`expressId <= 0`): a schedule can
   * be edited without any generated tasks (e.g. renamed a parsed task) and
   * must still trigger the rewrite.
   */
  scheduleIsEdited: boolean;

  /**
   * Snapshot undo/redo stacks for schedule edits. Each entry is a deep
   * clone of `scheduleData` taken BEFORE a mutator ran, so undo restores
   * the exact pre-mutation state byte-for-byte. Stack caps at 50 — older
   * snapshots are dropped from the bottom on overflow.
   *
   * Transactions: mutators invoked inside a `beginScheduleTransaction()` /
   * `endScheduleTransaction()` pair push exactly ONE snapshot at begin,
   * so a drag-gesture that fires 60 updateTaskTime calls still undoes as
   * one user-visible step.
   */
  scheduleUndoStack: ScheduleSnapshot[];
  scheduleRedoStack: ScheduleSnapshot[];

  /**
   * Transaction state for the edit pipeline. Lives in the store (not at
   * module scope) so parallel test stores, hot-reloaded sessions, and
   * multiple mounted viewer instances each have their own transaction
   * window. `pushedAt` tracks the stack depth at which `beginScheduleTransaction`
   * snapshotted, so `abortScheduleTransaction` can precisely unwind.
   */
  scheduleTransaction: { active: boolean; label: string; pushedAt: number };

  // ── Actions ──────────────────────────────────────────
  setScheduleData: (data: ScheduleExtraction | null) => void;
  setGanttPanelVisible: (visible: boolean) => void;
  toggleGanttPanel: () => void;
  setActiveWorkScheduleId: (globalId: string) => void;
  setGanttTimeScale: (scale: GanttTimeScale) => void;

  setGenerateScheduleDialogOpen: (open: boolean) => void;

  toggleTaskExpanded: (globalId: string) => void;
  expandAllTasks: () => void;
  collapseAllTasks: () => void;
  setHoveredTaskGlobalId: (globalId: string | null) => void;
  setSelectedTaskGlobalIds: (globalIds: string[]) => void;

  /**
   * Commit a *generated* schedule (from the Generate dialog) as a first-
   * class pending edit. Sets scheduleData + sourceModelId, marks the
   * source model as dirty, and bumps the mutation version so every
   * export-badge selector repaints.
   *
   * Extracted schedules go through `setScheduleData(data)` without a
   * sourceModelId — they're already in the host file, not pending.
   */
  commitGeneratedSchedule: (data: ScheduleExtraction, sourceModelId: string) => void;
  /**
   * Discard the generated tail of the current schedule — tasks with
   * `expressId <= 0` or missing. Keeps extracted tasks intact so
   * partial-authoring workflows (parsed schedule + user-appended task)
   * still reset cleanly. Returns the number of tasks removed.
   */
  clearGeneratedSchedule: () => number;

  // ── Schedule editing (P1) ──────────────────────────────
  /**
   * Patch a task's identity / descriptive fields. Silently no-ops when
   * the globalId isn't found. Enabling `isMilestone: true` also forces
   * `taskTime.scheduleDuration` to `PT0S` and `scheduleFinish` equal to
   * `scheduleStart` so the Gantt renders the diamond correctly.
   */
  updateTask: (
    globalId: string,
    patch: Partial<Pick<ScheduleTaskInfo,
      'name' | 'identification' | 'description' | 'longDescription'
      | 'objectType' | 'predefinedType' | 'isMilestone'>>,
  ) => void;
  /**
   * Patch a task's schedule time fields. The three related values
   * (`scheduleStart`, `scheduleFinish`, `scheduleDuration`) are kept
   * internally consistent: if the caller supplies any two, the third is
   * recomputed; if only one is supplied, the others are preserved from
   * the existing `taskTime`. Rejects finish-before-start by ignoring
   * that patch (caller can surface a validation error).
   */
  updateTaskTime: (
    globalId: string,
    patch: { scheduleStart?: string; scheduleFinish?: string; scheduleDuration?: string },
  ) => void;
  /**
   * Append products (renderer-space global IDs) to a task's assignment
   * list. Federation-aware: globals are translated to local expressIds
   * using the active source model's `idOffset`. De-duplicates against
   * existing membership so double-clicking "Add" is safe.
   */
  assignProductsToTask: (taskGlobalId: string, globalProductIds: number[]) => void;
  /** Remove products (global IDs) from a task's assignment list. */
  unassignProductsFromTask: (taskGlobalId: string, globalProductIds: number[]) => void;
  /**
   * Delete a task and cascade-clean dependent entities:
   *   • drop `IfcRelSequence` edges that reference it (either side)
   *   • reparent children to the deleted task's parent (or detach to root)
   *   • remove from the owning work-schedule's `taskGlobalIds`
   */
  deleteTask: (globalId: string) => void;
  /**
   * Create a brand-new task and insert it after `afterGlobalId` (or at the
   * end of the root-task list when absent). Inherits PredefinedType from
   * the task it's inserted after when possible; duration defaults to 5
   * days; start anchors to the predecessor's finish + 1 day (or the
   * schedule range's start when there's no predecessor).
   *
   * Returns the new task's globalId so callers can immediately select it
   * (the Gantt toolbar's "+ Task" button does this for a rename-right-
   * away flow).
   */
  addTask: (options?: {
    afterGlobalId?: string;
    parentGlobalId?: string | null;
    nameDefault?: string;
    predefinedTypeDefault?: string;
    durationDays?: number;
  }) => string;
  /**
   * Move a task to a new position in the flat root-order. v1 keeps the
   * parent unchanged (no re-parenting from tree drag yet — that's a
   * larger sub-feature). `newIndex` is interpreted in the context of
   * the current root-ordering, i.e. the position in
   * `workSchedule.taskGlobalIds`.
   */
  moveTask: (globalId: string, newIndex: number) => void;

  // ── Undo / redo ────────────────────────────────────────
  undoScheduleEdit: () => void;
  redoScheduleEdit: () => void;
  /**
   * Transactions coalesce a burst of rapid edits (bar drag, typing into
   * a field) into a single undo step: one snapshot at begin, later
   * mutators skip snapshotting until `endScheduleTransaction` closes the
   * window. `abortScheduleTransaction` pops the snapshot we pushed at
   * begin — use it when a drag is Esc-cancelled.
   */
  beginScheduleTransaction: (label: string) => void;
  endScheduleTransaction: () => void;
  abortScheduleTransaction: () => void;
}

/**
 * Derive a plausible finish time for a task when `ScheduleFinish` is absent.
 * Uses ScheduleDuration (ISO 8601 seconds) on top of ScheduleStart. Returns
 * undefined when no start time is available.
 */
function taskFinishEpoch(task: ScheduleTaskInfo): number | undefined {
  const start = parseIsoDate(task.taskTime?.scheduleStart ?? task.taskTime?.actualStart);
  const finish = parseIsoDate(task.taskTime?.scheduleFinish ?? task.taskTime?.actualFinish);
  if (finish !== undefined) return finish;
  if (start === undefined) return undefined;
  const duration = task.taskTime?.scheduleDuration ?? task.taskTime?.actualDuration;
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

function taskStartEpoch(task: ScheduleTaskInfo): number | undefined {
  return parseIsoDate(task.taskTime?.scheduleStart ?? task.taskTime?.actualStart);
}

/**
 * Compute the schedule time range across all tasks. Prefers real dates from
 * TaskTime attributes; falls back to a synthetic 0 … max-duration window.
 */
export function computeScheduleRange(data: ScheduleExtraction | null): ScheduleTimeRange | null {
  if (!data || data.tasks.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const task of data.tasks) {
    const start = taskStartEpoch(task);
    const finish = taskFinishEpoch(task);
    // Use whichever datapoint we have — a task with only ScheduleFinish still
    // anchors the range. Folding start into `max` (and finish into `min`) keeps
    // the range deterministic even when only one end is defined.
    if (start !== undefined) {
      min = Math.min(min, start);
      max = Math.max(max, start);
    }
    if (finish !== undefined) {
      min = Math.min(min, finish);
      max = Math.max(max, finish);
    }
  }
  if (Number.isFinite(min) && Number.isFinite(max) && max >= min) {
    // Single-point schedules get a nominal 1-day tail so the Gantt has something to render.
    return { start: min, end: max === min ? min + 86_400_000 : max, synthetic: false };
  }
  // No dates anywhere — synthesize a deterministic day-0 / +30d window keyed on
  // the task count so playback state survives reloads of the same model.
  const base = 0;
  return { start: base, end: base + 30 * 86_400_000, synthetic: true };
}

/**
 * Fields that live on OTHER slices but are read/written from the schedule
 * slice. Listed here so the StateCreator's generic parameter includes
 * them — this eliminates the `as unknown as { ... }` casts we'd otherwise
 * need at every cross-slice site and turns type errors on the other
 * slice's shape into compile errors here instead of silent runtime bugs.
 *
 * Kept as a small weakly-typed projection rather than importing the
 * owning slices' types (which would create a cycle through index.ts).
 */
interface ScheduleCrossSliceReads {
  /** modelSlice — id of the model the user is currently focused on. */
  activeModelId?: string | null;
  /** modelSlice — every model the viewer knows about, keyed by id. */
  models?: Map<string, { idOffset?: number }>;
  /** mutationSlice — set of model ids that have pending edits. */
  dirtyModels?: Set<string>;
  /** mutationSlice — monotonic version number; bumped on every write. */
  mutationVersion?: number;
  /** mutationSlice — per-model override views for property edits. */
  mutationViews?: Map<string, unknown>;
  /** mutationSlice — per-model georef overrides. */
  georefMutations?: Map<string, unknown>;
}

export const createScheduleSlice: StateCreator<
  ScheduleSlice & ScheduleCrossSliceReads,
  [],
  [],
  ScheduleSlice
> = (set, get) => ({
  // Initial state
  scheduleData: null,
  scheduleRange: null,
  activeWorkScheduleId: '',
  ganttPanelVisible: false,
  generateScheduleDialogOpen: false,
  expandedTaskGlobalIds: new Set(),
  hoveredTaskGlobalId: null,
  selectedTaskGlobalIds: new Set(),
  ganttTimeScale: 'week',
  scheduleSourceModelId: null,
  scheduleIsEdited: false,
  scheduleUndoStack: [],
  scheduleRedoStack: [],
  scheduleTransaction: { active: false, label: '', pushedAt: -1 },

  // Actions
  setScheduleData: (scheduleData) => {
    const range = computeScheduleRange(scheduleData);
    // Extracted-schedule attribution: even though the schedule wasn't
    // user-generated, every downstream consumer (export splice gate,
    // `mutationSlice.hasChanges`, the Inspector's pending chip) cares
    // about "which model does this schedule live in?". Previously
    // sourceModelId was only set by `commitGeneratedSchedule`, which
    // meant extracted schedules surfaced as `null` and downstream
    // reads had to fall through a single-model heuristic to cope. Now
    // we populate it from the active model at every `setScheduleData`
    // call so the field is always truthful.
    set(state => {
      const activeId = state.activeModelId ?? null;
      const single = state.models && state.models.size === 1
        ? (state.models.keys().next().value as string | undefined) ?? null
        : null;
      const derivedSourceModelId = scheduleData ? (activeId ?? single) : null;
      return {
        scheduleData,
        scheduleRange: range,
        // Reset playback to the schedule's start when loading new data.
        playbackTime: range?.start ?? 0,
        playbackIsPlaying: false,
        // Pick the first work schedule by default.
        activeWorkScheduleId: scheduleData?.workSchedules[0]?.globalId ?? '',
        // Expand roots by default so the user sees something.
        expandedTaskGlobalIds: new Set(
          scheduleData?.tasks.filter(t => !t.parentGlobalId).map(t => t.globalId) ?? [],
        ),
        selectedTaskGlobalIds: new Set(),
        hoveredTaskGlobalId: null,
        scheduleSourceModelId: derivedSourceModelId,
        // New data = clean slate. Edit state from a prior schedule doesn't
        // carry over.
        scheduleIsEdited: false,
        scheduleUndoStack: [],
        scheduleRedoStack: [],
        // Any in-flight transaction is abandoned when fresh data is loaded.
        scheduleTransaction: { active: false, label: '', pushedAt: -1 },
      } as Partial<ScheduleSlice>;
    });
  },

  setGanttPanelVisible: (ganttPanelVisible) => set({ ganttPanelVisible }),
  toggleGanttPanel: () => set((s) => ({ ganttPanelVisible: !s.ganttPanelVisible })),

  setActiveWorkScheduleId: (activeWorkScheduleId) => set({ activeWorkScheduleId }),
  setGanttTimeScale: (ganttTimeScale) => set({ ganttTimeScale }),

  setGenerateScheduleDialogOpen: (generateScheduleDialogOpen) => set({ generateScheduleDialogOpen }),

  toggleTaskExpanded: (globalId) => set((s) => {
    const next = new Set(s.expandedTaskGlobalIds);
    if (next.has(globalId)) next.delete(globalId);
    else next.add(globalId);
    return { expandedTaskGlobalIds: next };
  }),
  expandAllTasks: () => set((s) => ({
    expandedTaskGlobalIds: new Set(s.scheduleData?.tasks.map(t => t.globalId) ?? []),
  })),
  collapseAllTasks: () => set({ expandedTaskGlobalIds: new Set() }),

  setHoveredTaskGlobalId: (hoveredTaskGlobalId) => set({ hoveredTaskGlobalId }),
  setSelectedTaskGlobalIds: (ids) => set({ selectedTaskGlobalIds: new Set(ids) }),

  commitGeneratedSchedule: (data, sourceModelId) => {
    const range = computeScheduleRange(data);
    set(state => {
      const newDirty = new Set(state.dirtyModels);
      newDirty.add(sourceModelId);
      const bump = (state.mutationVersion ?? 0) + 1;
      return {
        scheduleData: data,
        scheduleRange: range,
        scheduleSourceModelId: sourceModelId,
        playbackTime: range?.start ?? 0,
        playbackIsPlaying: false,
        activeWorkScheduleId: data.workSchedules[0]?.globalId ?? '',
        expandedTaskGlobalIds: new Set(
          data.tasks.filter(t => !t.parentGlobalId).map(t => t.globalId),
        ),
        selectedTaskGlobalIds: new Set(),
        hoveredTaskGlobalId: null,
        // Generated schedules haven't been edited (they're brand-new);
        // stacks reset so users can't undo back to a pre-generation state
        // via the schedule undo UI (keeps the semantic crisp).
        scheduleIsEdited: false,
        scheduleUndoStack: [],
        scheduleRedoStack: [],
        scheduleTransaction: { active: false, label: '', pushedAt: -1 },
        // Cross-slice writes live behind a cast because the slice creator
        // is only typed for its own shape; the store combines slices so
        // these fields exist at runtime.
        dirtyModels: newDirty,
        mutationVersion: bump,
      } as Partial<ScheduleSlice>;
    });
  },

  clearGeneratedSchedule: () => {
    const current = get().scheduleData;
    if (!current || current.tasks.length === 0) return 0;

    const keptTasks = current.tasks.filter(t => t.expressId && t.expressId > 0);
    const removed = current.tasks.length - keptTasks.length;
    if (removed === 0) return 0;

    const keptTaskGlobalIds = new Set(keptTasks.map(t => t.globalId));
    // Drop sequences that pointed at removed tasks so the STEP never ends
    // up with a dangling IfcRelSequence referencing a deleted task.
    const keptSequences = current.sequences.filter(
      s => keptTaskGlobalIds.has(s.relatingTaskGlobalId)
        && keptTaskGlobalIds.has(s.relatedTaskGlobalId),
    );
    // Work schedules are authored per-generation — if we have no tasks
    // left, drop them too; otherwise keep whichever ones still control a
    // surviving task.
    const keptSchedules = keptTasks.length === 0
      ? []
      : current.workSchedules.filter(ws =>
          keptTasks.some(t => t.controllingScheduleGlobalIds.includes(ws.globalId)),
        );

    const next: ScheduleExtraction = keptTasks.length === 0
      ? { hasSchedule: false, workSchedules: [], tasks: [], sequences: [] }
      : { hasSchedule: true, workSchedules: keptSchedules, tasks: keptTasks, sequences: keptSequences };

    const nextRange = computeScheduleRange(keptTasks.length === 0 ? null : next);
    const sourceModelId = get().scheduleSourceModelId;

    set(state => {
      // Only remove the model from `dirtyModels` if this was its ONLY
      // outstanding edit — property / georef mutations keep it dirty.
      const newDirty = new Set(state.dirtyModels);
      if (sourceModelId) {
        const hasPropertyEdits = state.mutationViews?.has(sourceModelId) ?? false;
        const hasGeorefEdits = state.georefMutations?.has(sourceModelId) ?? false;
        if (!hasPropertyEdits && !hasGeorefEdits) {
          newDirty.delete(sourceModelId);
        }
      }
      const bump = (state.mutationVersion ?? 0) + 1;
      return {
        scheduleData: keptTasks.length === 0 ? null : next,
        scheduleRange: nextRange,
        scheduleSourceModelId: keptTasks.length === 0 ? null : sourceModelId,
        playbackTime: nextRange?.start ?? 0,
        playbackIsPlaying: false,
        selectedTaskGlobalIds: new Set(),
        hoveredTaskGlobalId: null,
        // Discarding generated tasks resets the edit state to "clean"
        // for the remaining parsed schedule. Any undo history from
        // prior edits is also dropped — you can't undo a discard.
        scheduleIsEdited: false,
        scheduleUndoStack: [],
        scheduleRedoStack: [],
        scheduleTransaction: { active: false, label: '', pushedAt: -1 },
        dirtyModels: newDirty,
        mutationVersion: bump,
      } as Partial<ScheduleSlice>;
    });

    return removed;
  },

  // ═════════════════════════════════════════════════════════════════════
  // Schedule editing (P1)
  //
  // All mutators funnel through the same pattern:
  //   1. If not inside a transaction, push a pre-mutation snapshot.
  //   2. Clone + patch `scheduleData` (deep enough — tasks/sequences/ws
  //      are shallow-patched, but the containing collection is rebuilt so
  //      Zustand's identity-based subscriptions fire).
  //   3. Recompute `scheduleRange` if time-affecting fields changed.
  //   4. Set `scheduleIsEdited = true`, mark the source model dirty, bump
  //      `mutationVersion` via the cross-slice cast so the export badge
  //      re-renders.
  // ═════════════════════════════════════════════════════════════════════

  updateTask: (globalId, patch) => {
    const current = get().scheduleData;
    if (!current) return;
    const idx = current.tasks.findIndex(t => t.globalId === globalId);
    if (idx < 0) return;

    // Which fields the patch actually touches — we snapshot exactly
    // these + `taskTime` if the milestone-collapse path applies, so
    // undo restores the minimum needed to reverse the edit.
    const touchedKeys: Array<keyof ScheduleTaskInfo> = [];
    if (patch.name !== undefined) touchedKeys.push('name');
    if (patch.identification !== undefined) touchedKeys.push('identification');
    if (patch.description !== undefined) touchedKeys.push('description');
    if (patch.longDescription !== undefined) touchedKeys.push('longDescription');
    if (patch.objectType !== undefined) touchedKeys.push('objectType');
    if (patch.predefinedType !== undefined) touchedKeys.push('predefinedType');
    if (patch.isMilestone !== undefined) {
      touchedKeys.push('isMilestone');
      if (patch.isMilestone) touchedKeys.push('taskTime');
    }
    if (touchedKeys.length === 0) return;

    const beforeFields = pickExistingFields(current.tasks[idx], touchedKeys);
    pushFieldPatchSnapshot(
      get, set,
      `Edit task: ${current.tasks[idx].name || 'untitled'}`,
      globalId,
      beforeFields,
    );

    const next = cloneExtraction(current);
    const t = next.tasks[idx];
    if (patch.name !== undefined) t.name = patch.name;
    if (patch.identification !== undefined) t.identification = patch.identification;
    if (patch.description !== undefined) t.description = patch.description;
    if (patch.longDescription !== undefined) t.longDescription = patch.longDescription;
    if (patch.objectType !== undefined) t.objectType = patch.objectType;
    if (patch.predefinedType !== undefined) t.predefinedType = patch.predefinedType;
    if (patch.isMilestone !== undefined) {
      t.isMilestone = patch.isMilestone;
      if (patch.isMilestone && t.taskTime) {
        // Milestones have zero duration — collapse finish to start and set
        // PT0S explicitly so the serializer emits it verbatim on export.
        t.taskTime = {
          ...t.taskTime,
          scheduleFinish: t.taskTime.scheduleStart ?? t.taskTime.scheduleFinish,
          scheduleDuration: 'PT0S',
        };
      }
    }
    commitEdit(get, set, next);
  },

  updateTaskTime: (globalId, patch) => {
    const current = get().scheduleData;
    if (!current) return;
    const idx = current.tasks.findIndex(t => t.globalId === globalId);
    if (idx < 0) return;

    // Validate BEFORE pushing a snapshot. Previously we'd push then
    // pop-on-reject, which was correct but left the rejected snapshot
    // briefly on the stack and forced the stack-length observers to
    // re-render. With field-patch snapshots we only need the `taskTime`
    // field's prior state, so compute the validation check against a
    // dry-run merge first.
    const prevTimeProbe = current.tasks[idx].taskTime ?? {};
    const mergedProbe = { ...prevTimeProbe, ...patch };
    const reconciledProbe = reconcileTaskTime(mergedProbe);
    if (!reconciledProbe) return; // finish < start — silent reject

    const beforeFields = pickExistingFields(current.tasks[idx], ['taskTime']);
    pushFieldPatchSnapshot(
      get, set,
      `Edit task time: ${current.tasks[idx].name || 'untitled'}`,
      globalId,
      beforeFields,
    );

    const next = cloneExtraction(current);
    const t = next.tasks[idx];
    const prevTime = t.taskTime ?? {};
    // Combine prior + patch; then reconcile start/finish/duration so
    // whichever pair the user supplied wins and the third is derived.
    const merged = { ...prevTime, ...patch };
    const reconciled = reconcileTaskTime(merged);
    if (!reconciled) {
      // Defensive — the probe above already caught this case, so this
      // branch shouldn't be reachable. Left in so we never commit a
      // malformed taskTime.
      const s = get();
      if (s.scheduleUndoStack.length > 0) {
        const popped = s.scheduleUndoStack.slice(0, -1);
        set({ scheduleUndoStack: popped });
      }
      return;
    }
    t.taskTime = reconciled;
    commitEdit(get, set, next);
  },

  assignProductsToTask: (taskGlobalId, globalProductIds) => {
    if (globalProductIds.length === 0) return;
    const current = get().scheduleData;
    if (!current) return;
    const idx = current.tasks.findIndex(t => t.globalId === taskGlobalId);
    if (idx < 0) return;

    // Federation: convert incoming globals → local expressIds using the
    // schedule's source model. When there's no source yet (purely parsed
    // schedule) fall back to the single-model assumption.
    const s = get();
    const sourceModelId = s.scheduleSourceModelId ?? resolveSingleModelId(s);
    const idOffset = resolveIdOffset(s, sourceModelId);
    const toLocal = (g: number): number => g - idOffset;

    pushScheduleSnapshot(get, set, `Assign ${globalProductIds.length} product(s)`);
    const next = cloneExtraction(current);
    const t = next.tasks[idx];
    const existingLocal = new Set(t.productExpressIds);
    const existingGlobal = new Set(t.productGlobalIds);
    for (const g of globalProductIds) {
      const local = toLocal(g);
      if (!existingLocal.has(local)) {
        t.productExpressIds.push(local);
        existingLocal.add(local);
      }
      const gs = String(g);
      if (!existingGlobal.has(gs)) {
        t.productGlobalIds.push(gs);
        existingGlobal.add(gs);
      }
    }
    commitEdit(get, set, next);
  },

  unassignProductsFromTask: (taskGlobalId, globalProductIds) => {
    if (globalProductIds.length === 0) return;
    const current = get().scheduleData;
    if (!current) return;
    const idx = current.tasks.findIndex(t => t.globalId === taskGlobalId);
    if (idx < 0) return;

    const s = get();
    const sourceModelId = s.scheduleSourceModelId ?? resolveSingleModelId(s);
    const idOffset = resolveIdOffset(s, sourceModelId);
    const localsToDrop = new Set(globalProductIds.map(g => g - idOffset));
    const globalsToDrop = new Set(globalProductIds.map(g => String(g)));

    pushScheduleSnapshot(get, set, `Remove ${globalProductIds.length} product(s)`);
    const next = cloneExtraction(current);
    const t = next.tasks[idx];
    t.productExpressIds = t.productExpressIds.filter(id => !localsToDrop.has(id));
    t.productGlobalIds = t.productGlobalIds.filter(gid => !globalsToDrop.has(gid));
    commitEdit(get, set, next);
  },

  deleteTask: (globalId) => {
    const current = get().scheduleData;
    if (!current) return;
    const target = current.tasks.find(t => t.globalId === globalId);
    if (!target) return;

    pushScheduleSnapshot(get, set, `Delete task: ${target.name || 'untitled'}`);
    const next = cloneExtraction(current);

    // Collect every descendant so we can also remove their tasks and the
    // sequences that reference them (cycle-safe BFS — we trust the tree
    // but don't assume it).
    const byId = new Map(next.tasks.map(t => [t.globalId, t] as const));
    const doomedIds = new Set<string>();
    const queue: string[] = [globalId];
    while (queue.length > 0) {
      const g = queue.shift()!;
      if (doomedIds.has(g)) continue;
      doomedIds.add(g);
      const task = byId.get(g);
      if (!task) continue;
      for (const child of task.childGlobalIds) {
        if (!doomedIds.has(child)) queue.push(child);
      }
    }

    // Reparent any survivors that reference a doomed parent (shouldn't
    // happen if the tree is well-formed, but doomedIds covers descendants
    // so this only catches weird multi-parent edges if they exist).
    for (const t of next.tasks) {
      if (doomedIds.has(t.globalId)) continue;
      if (t.parentGlobalId && doomedIds.has(t.parentGlobalId)) {
        t.parentGlobalId = target.parentGlobalId;
      }
      // Remove doomed children from surviving tasks' child lists.
      if (t.childGlobalIds.some(c => doomedIds.has(c))) {
        t.childGlobalIds = t.childGlobalIds.filter(c => !doomedIds.has(c));
      }
    }

    next.tasks = next.tasks.filter(t => !doomedIds.has(t.globalId));
    next.sequences = next.sequences.filter(s =>
      !doomedIds.has(s.relatingTaskGlobalId) && !doomedIds.has(s.relatedTaskGlobalId),
    );
    // Remove doomed task ids from any work schedule's taskGlobalIds.
    for (const ws of next.workSchedules) {
      if (ws.taskGlobalIds.some(g => doomedIds.has(g))) {
        ws.taskGlobalIds = ws.taskGlobalIds.filter(g => !doomedIds.has(g));
      }
    }
    if (next.tasks.length === 0) next.hasSchedule = false;

    // Also drop the deleted ids from the selection set so the Inspector
    // Task card dismisses cleanly.
    const selected = new Set(get().selectedTaskGlobalIds);
    let selectionChanged = false;
    for (const g of doomedIds) {
      if (selected.delete(g)) selectionChanged = true;
    }

    commitEdit(get, set, next, selectionChanged ? { selectedTaskGlobalIds: selected } : undefined);
  },

  addTask: (options) => {
    const current = get().scheduleData;
    const now = Date.now();
    // Fresh globalId: deterministic hash of timestamp + task count. The
    // two-stream 128-bit hash guarantees no collision even when the user
    // spams "Add" rapidly.
    const seed = `user-add|${now}|${current?.tasks.length ?? 0}|${Math.random().toString(36).slice(2, 8)}`;
    const newGid = deterministicGlobalId(seed);
    const afterGid = options?.afterGlobalId;
    const durationDays = Math.max(0.5, options?.durationDays ?? 5);
    const name = options?.nameDefault ?? 'New task';
    const predefinedType = options?.predefinedTypeDefault ?? 'CONSTRUCTION';

    pushScheduleSnapshot(get, set, `Add task: ${name}`);
    const next = current
      ? cloneExtraction(current)
      : { hasSchedule: true, workSchedules: [], sequences: [], tasks: [] } as ScheduleExtraction;

    // Derive default start: after the predecessor's finish when we have
    // one, otherwise the schedule range start, otherwise today at 08:00.
    const predIdx = afterGid ? next.tasks.findIndex(t => t.globalId === afterGid) : -1;
    let startIso: string;
    if (predIdx >= 0) {
      const predFinish = parseIsoDate(next.tasks[predIdx].taskTime?.scheduleFinish);
      startIso = predFinish !== undefined
        ? toIsoUtc(predFinish)
        : (next.tasks[predIdx].taskTime?.scheduleStart ?? isoNowAt8());
    } else {
      const rangeStart = computeScheduleRange(next)?.start;
      startIso = rangeStart !== undefined ? toIsoUtc(rangeStart) : isoNowAt8();
    }
    const startMs = parseIsoDate(startIso) ?? Date.now();
    const finishMs = startMs + durationDays * 86_400_000;

    const newTask: ScheduleTaskInfo = {
      expressId: 0,
      globalId: newGid,
      name,
      isMilestone: false,
      predefinedType,
      childGlobalIds: [],
      productExpressIds: [],
      productGlobalIds: [],
      controllingScheduleGlobalIds: next.workSchedules[0]
        ? [next.workSchedules[0].globalId]
        : [],
      taskTime: {
        scheduleStart: startIso,
        scheduleFinish: toIsoUtc(finishMs),
        scheduleDuration: msToIsoDuration(finishMs - startMs),
      },
    };

    // Insert in the tasks array after the predecessor (or at end).
    if (predIdx >= 0) next.tasks.splice(predIdx + 1, 0, newTask);
    else next.tasks.push(newTask);

    // Mirror insertion in the owning work-schedule's taskGlobalIds list
    // so renderers that walk via work-schedule see the new task. If no
    // work schedule exists, synthesise one — can't emit a schedule of
    // orphan tasks.
    if (next.workSchedules.length === 0) {
      next.workSchedules.push({
        expressId: 0,
        globalId: deterministicGlobalId(`user-add|ws|${now}`),
        kind: 'WorkSchedule',
        name: 'Construction schedule',
        description: 'User-authored',
        creationDate: startIso,
        startTime: startIso,
        finishTime: toIsoUtc(finishMs),
        predefinedType: 'PLANNED',
        taskGlobalIds: [newGid],
      });
      newTask.controllingScheduleGlobalIds = [next.workSchedules[0].globalId];
    } else {
      const ws = next.workSchedules[0];
      const wsPredIdx = afterGid ? ws.taskGlobalIds.indexOf(afterGid) : -1;
      if (wsPredIdx >= 0) ws.taskGlobalIds.splice(wsPredIdx + 1, 0, newGid);
      else ws.taskGlobalIds.push(newGid);
    }
    next.hasSchedule = true;

    // Auto-select the new task so the Inspector's Task card lights up
    // for immediate rename.
    const nextSelected = new Set<string>([newGid]);
    commitEdit(get, set, next, { selectedTaskGlobalIds: nextSelected });

    return newGid;
  },

  moveTask: (globalId, newIndex) => {
    const current = get().scheduleData;
    if (!current) return;
    const srcIdx = current.tasks.findIndex(t => t.globalId === globalId);
    if (srcIdx < 0) return;

    pushScheduleSnapshot(get, set, `Move task: ${current.tasks[srcIdx].name || 'untitled'}`);
    const next = cloneExtraction(current);

    // Move in the tasks array. Clamp to valid bounds.
    const safeNewIdx = Math.max(0, Math.min(next.tasks.length - 1, newIndex));
    const [moved] = next.tasks.splice(srcIdx, 1);
    // Adjust target index when moving downward: the splice above removed
    // one element before the drop position, so the effective target
    // shifts by one.
    const targetIdx = srcIdx < safeNewIdx ? safeNewIdx : safeNewIdx;
    next.tasks.splice(targetIdx, 0, moved);

    // Mirror the move in every work-schedule that owns the task so
    // STEP round-trip preserves order.
    for (const ws of next.workSchedules) {
      const wsIdx = ws.taskGlobalIds.indexOf(globalId);
      if (wsIdx < 0) continue;
      const wsTarget = srcIdx < safeNewIdx ? safeNewIdx : safeNewIdx;
      ws.taskGlobalIds.splice(wsIdx, 1);
      ws.taskGlobalIds.splice(Math.max(0, Math.min(ws.taskGlobalIds.length, wsTarget)), 0, globalId);
    }

    commitEdit(get, set, next);
  },

  undoScheduleEdit: () => {
    const s = get();
    if (s.scheduleUndoStack.length === 0) return;
    const top = s.scheduleUndoStack[s.scheduleUndoStack.length - 1];
    const newUndo = s.scheduleUndoStack.slice(0, -1);
    // Capture current state for redo BEFORE restoring — matching the
    // popped entry's kind so redo can symmetrically re-apply.
    const redoEntry = captureInverseSnapshot(s, top);
    const newRedo = [...s.scheduleRedoStack, redoEntry].slice(-SCHEDULE_STACK_MAX);
    applySnapshot(get, set, top, newUndo, newRedo);
  },

  redoScheduleEdit: () => {
    const s = get();
    if (s.scheduleRedoStack.length === 0) return;
    const top = s.scheduleRedoStack[s.scheduleRedoStack.length - 1];
    const newRedo = s.scheduleRedoStack.slice(0, -1);
    const undoEntry = captureInverseSnapshot(s, top);
    const newUndo = [...s.scheduleUndoStack, undoEntry].slice(-SCHEDULE_STACK_MAX);
    applySnapshot(get, set, top, newUndo, newRedo);
  },

  beginScheduleTransaction: (label) => {
    // One snapshot for the whole transaction. Skip if one's already open.
    const s = get();
    if (s.scheduleTransaction.active) return;
    set({
      scheduleTransaction: {
        active: true,
        label,
        pushedAt: s.scheduleUndoStack.length,
      },
    });
    pushScheduleSnapshot(get, set, label, /* forceIgnoreTxn */ true);
  },

  endScheduleTransaction: () => {
    set({ scheduleTransaction: { active: false, label: '', pushedAt: -1 } });
  },

  abortScheduleTransaction: () => {
    const s = get();
    const txn = s.scheduleTransaction;
    if (!txn.active) return;
    // Pop the snapshot we pushed at begin — only if it's still the top.
    if (s.scheduleUndoStack.length === txn.pushedAt + 1) {
      const entry = s.scheduleUndoStack[s.scheduleUndoStack.length - 1];
      if (entry.label === txn.label) {
        // Restoring the snapshot also reverts any mutations we made
        // during the transaction.
        const newUndo = s.scheduleUndoStack.slice(0, -1);
        applySnapshot(get, set, entry, newUndo, s.scheduleRedoStack);
      }
    }
    set({ scheduleTransaction: { active: false, label: '', pushedAt: -1 } });
  },
});

// ═════════════════════════════════════════════════════════════════════
// Internal helpers for schedule editing
// ═════════════════════════════════════════════════════════════════════

const SCHEDULE_STACK_MAX = 50;

/**
 * Push a pre-mutation FULL snapshot onto the undo stack, clear the redo
 * stack (as is standard for undo UIs — any new edit after an undo forks
 * history). Skipped when a transaction is active unless the caller
 * passes `forceIgnoreTxn`.
 *
 * Structural edits (add / delete / move / assign / unassign) use this.
 * For lightweight field edits on a single task, prefer
 * {@link pushFieldPatchSnapshot} — same semantics, ~200× smaller entry.
 */
function pushScheduleSnapshot(
  get: () => ScheduleSlice & ScheduleCrossSliceReads,
  set: (
    patch:
      | Partial<ScheduleSlice>
      | ((state: ScheduleSlice & ScheduleCrossSliceReads) => Partial<ScheduleSlice>),
  ) => void,
  label: string,
  forceIgnoreTxn = false,
): void {
  const s = get();
  if (s.scheduleTransaction.active && !forceIgnoreTxn) return;
  if (!s.scheduleData) return;
  const entry: ScheduleFullSnapshot = {
    kind: 'full',
    label,
    data: cloneExtraction(s.scheduleData),
    range: s.scheduleRange,
    isEdited: s.scheduleIsEdited,
  };
  const nextUndo = [...s.scheduleUndoStack, entry].slice(-SCHEDULE_STACK_MAX);
  set({
    scheduleUndoStack: nextUndo,
    scheduleRedoStack: [], // fork — clear redo
  });
}

/**
 * Push a pre-mutation FIELD-PATCH snapshot for a single-task edit.
 * Captures only the task's globalId + the before-state of fields that
 * will change. ~100 bytes per entry regardless of schedule size.
 *
 * `beforeFields` should be the EXACT set of keys the mutator is about
 * to overwrite — if the patch isn't a strict subset of what's mutated,
 * undo replays from the wrong baseline. Use `pickExistingFields` to
 * capture from the live task.
 */
function pushFieldPatchSnapshot(
  get: () => ScheduleSlice & ScheduleCrossSliceReads,
  set: (
    patch:
      | Partial<ScheduleSlice>
      | ((state: ScheduleSlice & ScheduleCrossSliceReads) => Partial<ScheduleSlice>),
  ) => void,
  label: string,
  taskGlobalId: string,
  beforeFields: Partial<ScheduleTaskInfo>,
): void {
  const s = get();
  if (s.scheduleTransaction.active) return;
  if (!s.scheduleData) return;
  const entry: ScheduleFieldPatchSnapshot = {
    kind: 'fieldPatch',
    label,
    taskGlobalId,
    before: beforeFields,
    priorRange: s.scheduleRange,
    priorIsEdited: s.scheduleIsEdited,
  };
  const nextUndo = [...s.scheduleUndoStack, entry].slice(-SCHEDULE_STACK_MAX);
  set({
    scheduleUndoStack: nextUndo,
    scheduleRedoStack: [], // fork — clear redo
  });
}

/**
 * Capture the current value of the given fields from a task so we can
 * restore them on undo. Deep-copies arrays / nested structs (taskTime)
 * so later mutations can't alias the snapshot.
 */
function pickExistingFields(
  task: ScheduleTaskInfo,
  keys: ReadonlyArray<keyof ScheduleTaskInfo>,
): Partial<ScheduleTaskInfo> {
  const out: Partial<ScheduleTaskInfo> = {};
  for (const k of keys) {
    const v = task[k];
    if (v === undefined) {
      (out as Record<string, unknown>)[k] = undefined;
    } else if (typeof v === 'object' && v !== null) {
      // Plain object or array — deep clone to break aliasing.
      (out as Record<string, unknown>)[k] = structuredClone(v);
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * Finalise an edit: replace `scheduleData`, recompute range, flip the
 * edited flag, cross-slice-mark dirty, bump mutation version.
 */
function commitEdit(
  get: () => ScheduleSlice & ScheduleCrossSliceReads,
  set: (
    patch:
      | Partial<ScheduleSlice>
      | ((state: ScheduleSlice & ScheduleCrossSliceReads) => Partial<ScheduleSlice>),
  ) => void,
  next: ScheduleExtraction,
  extra?: Partial<ScheduleSlice>,
): void {
  const range = computeScheduleRange(next);
  set(state => {
    const sourceModelId = state.scheduleSourceModelId;
    const newDirty = new Set(state.dirtyModels);
    if (sourceModelId) newDirty.add(sourceModelId);
    const bump = (state.mutationVersion ?? 0) + 1;
    return {
      ...(extra ?? {}),
      scheduleData: next,
      scheduleRange: range,
      scheduleIsEdited: true,
      dirtyModels: newDirty,
      mutationVersion: bump,
    } as Partial<ScheduleSlice>;
  });
  // Touch `get` so the linter doesn't complain about the unused arg.
  // Reading here (post-set) is also cheap and keeps the signature
  // symmetric with the other helpers.
  void get();
}

/**
 * Build an "inverse snapshot" of the current state that matches the
 * shape of the entry we're about to pop. For `full` entries we deep-
 * clone the entire extraction; for `fieldPatch` entries we capture
 * the task's current field values so a later redo can re-apply them.
 *
 * Preserving the kind symmetry guarantees that undo → redo → undo
 * brings the state back to byte-identical (the symmetry test in
 * scheduleSlice.test.ts locks this down).
 */
function captureInverseSnapshot(
  state: ScheduleSlice,
  entry: ScheduleSnapshot,
): ScheduleSnapshot {
  if (entry.kind === 'full') {
    return {
      kind: 'full',
      label: entry.label,
      data: state.scheduleData ? cloneExtraction(state.scheduleData) : null,
      range: state.scheduleRange,
      isEdited: state.scheduleIsEdited,
    };
  }
  // fieldPatch — mirror by capturing current values of the same keys
  // and the current range / edited flag.
  const task = state.scheduleData?.tasks.find(t => t.globalId === entry.taskGlobalId);
  const keys = Object.keys(entry.before) as Array<keyof ScheduleTaskInfo>;
  const currentFields = task ? pickExistingFields(task, keys) : {};
  return {
    kind: 'fieldPatch',
    label: entry.label,
    taskGlobalId: entry.taskGlobalId,
    before: currentFields,
    priorRange: state.scheduleRange,
    priorIsEdited: state.scheduleIsEdited,
  };
}

/**
 * Restore a snapshot (shared by undo + redo + abort). Keeps the undo /
 * redo stacks the caller decided on, rather than deriving from `top`.
 */
function applySnapshot(
  get: () => ScheduleSlice & ScheduleCrossSliceReads,
  set: (
    patch:
      | Partial<ScheduleSlice>
      | ((state: ScheduleSlice & ScheduleCrossSliceReads) => Partial<ScheduleSlice>),
  ) => void,
  snap: ScheduleSnapshot,
  newUndo: ScheduleSnapshot[],
  newRedo: ScheduleSnapshot[],
): void {
  if (snap.kind === 'full') {
    set(state => {
      const sourceModelId = state.scheduleSourceModelId;
      const newDirty = new Set(state.dirtyModels);
      if (sourceModelId) {
        if (snap.isEdited) newDirty.add(sourceModelId);
        else newDirty.delete(sourceModelId);
      }
      const bump = (state.mutationVersion ?? 0) + 1;
      return {
        scheduleData: snap.data,
        scheduleRange: snap.range,
        scheduleIsEdited: snap.isEdited,
        scheduleUndoStack: newUndo,
        scheduleRedoStack: newRedo,
        dirtyModels: newDirty,
        mutationVersion: bump,
      } as Partial<ScheduleSlice>;
    });
    void get();
    return;
  }

  // Field-patch restore: find the task by globalId and overwrite only
  // the fields captured in `before`. The rest of `scheduleData` is
  // untouched — structurally we don't need a full clone.
  set(state => {
    const sourceModelId = state.scheduleSourceModelId;
    const newDirty = new Set(state.dirtyModels);
    if (sourceModelId) {
      if (snap.priorIsEdited) newDirty.add(sourceModelId);
      else newDirty.delete(sourceModelId);
    }
    const bump = (state.mutationVersion ?? 0) + 1;

    // Patch the single affected task. Clone the extraction shallowly so
    // Zustand identity-based subscriptions fire; deeper structures that
    // weren't touched stay referentially stable.
    const current = state.scheduleData;
    let nextData: ScheduleExtraction | null = current;
    if (current) {
      const idx = current.tasks.findIndex(t => t.globalId === snap.taskGlobalId);
      if (idx >= 0) {
        const nextTasks = current.tasks.slice();
        nextTasks[idx] = { ...current.tasks[idx], ...snap.before };
        nextData = { ...current, tasks: nextTasks };
      }
    }

    return {
      scheduleData: nextData,
      scheduleRange: snap.priorRange,
      scheduleIsEdited: snap.priorIsEdited,
      scheduleUndoStack: newUndo,
      scheduleRedoStack: newRedo,
      dirtyModels: newDirty,
      mutationVersion: bump,
    } as Partial<ScheduleSlice>;
  });
  void get();
}

// ── Derived selectors ────────────────────────────────────────────────────

/**
 * True when the task participates in the given work-schedule filter.
 *
 * An empty or null `scheduleGlobalId` means "no filter" — every task passes.
 * Tasks whose `controllingScheduleGlobalIds` is empty are treated as
 * always-visible so they still contribute to playback when a schedule is
 * selected but the extractor didn't record controlling-schedule info.
 */
function taskMatchesScheduleFilter(
  task: ScheduleTaskInfo,
  scheduleGlobalId: string | null | undefined,
): boolean {
  if (!scheduleGlobalId) return true;
  if (task.controllingScheduleGlobalIds.length === 0) return true;
  return task.controllingScheduleGlobalIds.includes(scheduleGlobalId);
}

/**
 * Compute the set of product expressIds that should be hidden at the given
 * playback time. A product is hidden when every task that assigns it has
 * `scheduleStart > playbackTime`. Products with no controlling task are
 * always shown.
 *
 * `scheduleGlobalId` (optional) restricts evaluation to tasks controlled by
 * that IfcWorkSchedule / IfcWorkPlan. Pass `null`/`undefined`/`''` to treat
 * all tasks as in-scope. Federation-aware ID translation is the caller's
 * responsibility — these selectors stay pure and return local expressIds.
 */
export function computeHiddenProductIds(
  data: ScheduleExtraction | null,
  playbackTime: number,
  scheduleGlobalId?: string | null,
): Set<number> {
  const hidden = new Set<number>();
  if (!data) return hidden;
  /** product expressId -> true iff it was revealed by at least one task. */
  const revealed = new Map<number, boolean>();
  for (const task of data.tasks) {
    if (!taskMatchesScheduleFilter(task, scheduleGlobalId)) continue;
    const start = taskStartEpoch(task);
    if (task.productExpressIds.length === 0) continue;
    // If no scheduled start, treat the task as always-active (don't hide its products).
    const isRevealed = start === undefined ? true : start <= playbackTime;
    for (const id of task.productExpressIds) {
      if (isRevealed) {
        revealed.set(id, true);
      } else if (!revealed.has(id)) {
        revealed.set(id, false);
      }
    }
  }
  for (const [id, isRevealed] of revealed) {
    if (!isRevealed) hidden.add(id);
  }
  return hidden;
}

/**
 * Compute product expressIds that are currently part of an in-progress task —
 * useful for highlighting the "active construction front" during playback.
 *
 * `scheduleGlobalId` semantics mirror {@link computeHiddenProductIds}.
 */
export function computeActiveProductIds(
  data: ScheduleExtraction | null,
  playbackTime: number,
  scheduleGlobalId?: string | null,
): Set<number> {
  const active = new Set<number>();
  if (!data) return active;
  for (const task of data.tasks) {
    if (!taskMatchesScheduleFilter(task, scheduleGlobalId)) continue;
    const start = taskStartEpoch(task);
    const finish = taskFinishEpoch(task);
    if (start === undefined || finish === undefined) continue;
    if (playbackTime >= start && playbackTime <= finish) {
      for (const id of task.productExpressIds) active.add(id);
    }
  }
  return active;
}

export { taskStartEpoch, taskFinishEpoch, parseIsoDate };

/**
 * Count tasks that the user generated locally — tasks with no existing
 * `expressId` in the host STEP file. These are the "pending schedule
 * edits" equivalent of property mutations: they need to be serialized
 * and spliced into the STEP on export.
 *
 * Matches the partitioning rule in `export-adapter.injectScheduleIntoStep`
 * so the count, dirty flag, and export path agree on what counts.
 */
export function countGeneratedTasks(data: ScheduleExtraction | null | undefined): number {
  if (!data || data.tasks.length === 0) return 0;
  let n = 0;
  for (const t of data.tasks) {
    if (!t.expressId || t.expressId <= 0) n++;
  }
  return n;
}
