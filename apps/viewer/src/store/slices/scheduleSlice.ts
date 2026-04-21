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
   * Master toggle for the Gantt ↔ 3D viewport linkage.
   *
   * When `true` (default):
   *   • Selecting Gantt row(s) isolates their products in the 3D viewport
   *   • Clicking a product in the 3D viewport highlights the owning task
   *     in the Gantt (expands ancestors + scrolls into view)
   *   • Double-click on a Gantt row frames the camera on its products
   *   • `I` isolates, `F` frames, `Esc` clears (when Gantt has focus)
   *
   * When `false`, the Gantt and 3D viewport are fully decoupled — useful
   * during schedule authoring when a user wants to pan/orbit freely
   * without isolation snapping to whatever row they just clicked.
   *
   * Persisted in the slice (not a ref) so the command palette / settings
   * panels can read + toggle it without prop-drilling.
   */
  ganttSync3D: boolean;

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
  /** Toggle / set the Gantt ↔ 3D viewport sync master switch. */
  setGanttSync3D: (enabled: boolean) => void;
  toggleGanttSync3D: () => void;
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
  ganttSync3D: true,

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
  setGanttSync3D: (ganttSync3D) => set({ ganttSync3D }),
  toggleGanttSync3D: () => set((s) => ({ ganttSync3D: !s.ganttSync3D })),
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
