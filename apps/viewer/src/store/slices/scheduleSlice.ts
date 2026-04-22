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
import type { AnimationSettings } from '@/components/viewer/schedule/schedule-animator';
import { DEFAULT_ANIMATION_SETTINGS } from '@/components/viewer/schedule/schedule-animator';

export type GanttTimeScale = 'hour' | 'day' | 'week' | 'month' | 'year';

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

  // ── Playback ─────────────────────────────────────────
  /** Animation master toggle — when false the viewer renders normally. */
  animationEnabled: boolean;
  /** Is the playback currently advancing? */
  playbackIsPlaying: boolean;
  /** Current playback time, epoch ms. */
  playbackTime: number;
  /** Playback rate in simulated-days-per-real-second. */
  playbackSpeed: number;
  /** When true, looping from end → start. */
  playbackLoop: boolean;
  /**
   * Animation style + palette settings. See `schedule-animator.ts` for the
   * phase / colour model. `minimal` keeps the original visibility-only
   * behaviour; `phased` lights up the type-colour lifecycle.
   */
  animationSettings: AnimationSettings;

  /**
   * Model the current `scheduleData` is attributed to, for federation +
   * dirty-tracking integration. Set by `commitGeneratedSchedule` when the
   * user generates a schedule from the spatial hierarchy; remains null
   * when the schedule came from extraction (extracted tasks already exist
   * in the host STEP file and aren't "pending").
   */
  scheduleSourceModelId: string | null;

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

  setAnimationEnabled: (enabled: boolean) => void;
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
  /** Replace the full animation-settings object. */
  setAnimationSettings: (settings: AnimationSettings) => void;
  /** Shallow-merge patch — convenient for toolbar toggles. */
  patchAnimationSettings: (patch: Partial<AnimationSettings>) => void;
  /** Restore the built-in Synchro-style defaults. */
  resetAnimationSettings: () => void;
  playSchedule: () => void;
  pauseSchedule: () => void;
  togglePlaySchedule: () => void;
  seekSchedule: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  setPlaybackLoop: (loop: boolean) => void;
  advancePlaybackBy: (deltaMs: number) => void;
}

/**
 * Convert an ISO 8601 datetime string to epoch ms. Returns undefined when
 * the input is missing or unparseable.
 *
 * `IfcDateTime` values produced by authoring tools are typically written
 * without a timezone designator (e.g. `2024-05-01T08:00:00`). `Date.parse`
 * treats those as *local* time, so the same IFC opened on machines in
 * different timezones would yield different epoch values — shifting the
 * Gantt and breaking equality with exported STEP strings. We normalize
 * TZ-less inputs to UTC (append `Z`) so playback stays stable across
 * machines and STEP round-trips.
 */
function parseIsoDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(value);
  const normalized = hasTz ? value : `${value}Z`;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? undefined : t;
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

export const createScheduleSlice: StateCreator<ScheduleSlice, [], [], ScheduleSlice> = (set, get) => ({
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
  animationEnabled: false,
  playbackIsPlaying: false,
  playbackTime: 0,
  playbackSpeed: 7, // 7 simulated days per real second by default
  playbackLoop: true,
  animationSettings: DEFAULT_ANIMATION_SETTINGS,
  scheduleSourceModelId: null,

  // Actions
  setScheduleData: (scheduleData) => {
    const range = computeScheduleRange(scheduleData);
    set({
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

  setAnimationEnabled: (animationEnabled) => set({ animationEnabled }),

  commitGeneratedSchedule: (data, sourceModelId) => {
    const range = computeScheduleRange(data);
    set(state => {
      const newDirty = new Set((state as unknown as { dirtyModels?: Set<string> }).dirtyModels);
      newDirty.add(sourceModelId);
      const bump = ((state as unknown as { mutationVersion?: number }).mutationVersion ?? 0) + 1;
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
      const crossState = state as unknown as {
        dirtyModels?: Set<string>;
        mutationViews?: Map<string, unknown>;
        georefMutations?: Map<string, unknown>;
        mutationVersion?: number;
      };
      // Only remove the model from `dirtyModels` if this was its ONLY
      // outstanding edit — property / georef mutations keep it dirty.
      const newDirty = new Set(crossState.dirtyModels);
      if (sourceModelId) {
        const hasPropertyEdits = crossState.mutationViews?.has(sourceModelId) ?? false;
        const hasGeorefEdits = crossState.georefMutations?.has(sourceModelId) ?? false;
        if (!hasPropertyEdits && !hasGeorefEdits) {
          newDirty.delete(sourceModelId);
        }
      }
      const bump = (crossState.mutationVersion ?? 0) + 1;
      return {
        scheduleData: keptTasks.length === 0 ? null : next,
        scheduleRange: nextRange,
        scheduleSourceModelId: keptTasks.length === 0 ? null : sourceModelId,
        playbackTime: nextRange?.start ?? 0,
        playbackIsPlaying: false,
        selectedTaskGlobalIds: new Set(),
        hoveredTaskGlobalId: null,
        dirtyModels: newDirty,
        mutationVersion: bump,
      } as Partial<ScheduleSlice>;
    });

    return removed;
  },
  setAnimationSettings: (animationSettings) => set({ animationSettings }),
  patchAnimationSettings: (patch) => set((s) => ({
    animationSettings: { ...s.animationSettings, ...patch },
  })),
  resetAnimationSettings: () => set({ animationSettings: DEFAULT_ANIMATION_SETTINGS }),
  playSchedule: () => set({ playbackIsPlaying: true, animationEnabled: true }),
  pauseSchedule: () => set({ playbackIsPlaying: false }),
  togglePlaySchedule: () => set((s) => {
    const next = !s.playbackIsPlaying;
    return {
      playbackIsPlaying: next,
      animationEnabled: next ? true : s.animationEnabled,
    };
  }),
  seekSchedule: (time) => set({ playbackTime: time }),
  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),
  setPlaybackLoop: (playbackLoop) => set({ playbackLoop }),

  advancePlaybackBy: (deltaMs) => {
    const s = get();
    if (!s.playbackIsPlaying || !s.scheduleRange) return;
    // Clamp the wall-clock delta before scaling. rAF pauses when the tab is
    // hidden, OS sleeps, or a breakpoint fires; the next frame fires with a
    // multi-second delta. At the default 7 days/sec that would skip weeks of
    // schedule in one step, either missing animation states or overshooting
    // the end of non-looping playback.
    const MAX_DELTA_MS = 100;
    const clamped = Math.min(Math.max(deltaMs, 0), MAX_DELTA_MS);
    // speed = simulated days / real second
    //   → simulated ms = (deltaMs / 1000) * speed * 86_400_000
    //                  = deltaMs * speed * 86_400
    const simulated = clamped * s.playbackSpeed * 86_400;
    let next = s.playbackTime + simulated;
    if (next > s.scheduleRange.end) {
      if (s.playbackLoop) {
        next = s.scheduleRange.start;
      } else {
        set({ playbackTime: s.scheduleRange.end, playbackIsPlaying: false });
        return;
      }
    }
    set({ playbackTime: next });
  },
});

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
