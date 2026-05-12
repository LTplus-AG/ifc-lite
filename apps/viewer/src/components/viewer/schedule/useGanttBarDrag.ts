/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useGanttBarDrag — direct-manipulation for task bars.
 *
 * Three drag modes:
 *   • `shift` (body) — moves start+finish together, duration unchanged.
 *   • `resize-start` (left edge) — anchors finish, updates start (and
 *     therefore duration).
 *   • `resize-finish` (right edge) — anchors start, updates finish
 *     (and therefore duration).
 *
 * Snaps the live-dragged delta to a scale-appropriate unit (hour /
 * day / week) unless the user holds Shift. Pointer capture keeps the
 * drag alive outside the SVG. Esc aborts and restores the task to
 * pre-drag state via `abortScheduleTransaction`.
 *
 * Transaction semantics: one `beginScheduleTransaction` at pointerdown
 * means a 60-frame drag lands in the undo stack as ONE entry. End /
 * abort close the window so the next edit opens a new entry.
 *
 * Playback: if the user was animating, we pause at drag start so the
 * animator's hidden-id recompute doesn't fight the live `updateTaskTime`
 * calls, then resume on successful release. Aborts don't resume (Esc
 * is a rollback of everything the user did, including any implicit
 * state changes).
 */

import { useCallback, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import type { GanttTimeScale, ScheduleTimeRange } from '@/store';

export type BarDragMode = 'shift' | 'resize-start' | 'resize-finish';

/** Snap granularity per timeline scale, in milliseconds. */
const SNAP_MS_BY_SCALE: Record<GanttTimeScale, number> = {
  hour: 15 * 60 * 1000,              // 15 minutes
  day: 60 * 60 * 1000,               //  1 hour
  week: 24 * 60 * 60 * 1000,         //  1 day
  month: 24 * 60 * 60 * 1000,        //  1 day
  year: 7 * 24 * 60 * 60 * 1000,     //  1 week
};

/** Snap `ms` to the nearest multiple of `unit`. `ms` is a delta, not an epoch.
 *
 *  Normalises negative zero to +0 — `Math.round(-0.4) === -0`, and -0 * X
 *  stays -0 in JS, which then surfaces as a weird `-PT0S` duration in
 *  downstream serialisers. The `|| 0` falls through for exact zero and
 *  is a no-op for any finite non-zero result. */
export function snapDeltaMs(deltaMs: number, unit: number): number {
  if (unit <= 0) return deltaMs;
  return (Math.round(deltaMs / unit) * unit) || 0;
}

/** Pixels per millisecond from the timeline's width and time span. */
export function pxPerMs(pixelWidth: number, range: ScheduleTimeRange): number {
  const span = range.end - range.start;
  if (span <= 0 || pixelWidth <= 0) return 0;
  return pixelWidth / span;
}

/** Convert epoch ms → ISO-8601 UTC with seconds (no ms), matching the parser. */
function epochToIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function parseIso(iso?: string): number | undefined {
  if (!iso) return undefined;
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(iso);
  const t = Date.parse(hasTz ? iso : `${iso}Z`);
  return Number.isNaN(t) ? undefined : t;
}

/** Milliseconds → ISO-8601 duration (same shape the animator / exporter emit). */
function msToIsoDuration(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped === 0) return 'PT0S';
  const days = Math.floor(clamped / 86_400_000);
  const remAfterDays = clamped - days * 86_400_000;
  const hours = Math.floor(remAfterDays / 3_600_000);
  const remAfterHours = remAfterDays - hours * 3_600_000;
  const mins = Math.floor(remAfterHours / 60_000);
  let out = 'P';
  if (days > 0) out += `${days}D`;
  if (hours > 0 || mins > 0) {
    out += 'T';
    if (hours > 0) out += `${hours}H`;
    if (mins > 0) out += `${mins}M`;
  }
  return out === 'P' ? 'P0D' : out;
}

interface DragSession {
  taskGlobalId: string;
  mode: BarDragMode;
  /** Pointer screen-X where the drag started. */
  startClientX: number;
  /** Pixel-to-ms conversion captured at pointerdown — stays stable for the
   *  whole drag even if the viewport resizes mid-drag (user would expect
   *  the dragged bar to track the cursor, not re-scale). */
  pxPerMs: number;
  /** Original times so abort / resize anchors are authoritative. */
  originalStartMs: number;
  originalFinishMs: number;
  /** Resume playback on release if it was on at begin. */
  resumePlayback: boolean;
  /** Live preview values so the floating tooltip can render without a
   *  store round-trip on every mousemove frame. */
  liveStartMs: number;
  liveFinishMs: number;
}

export interface BarDragLive {
  /** globalId of the task currently being dragged, or null if none. */
  taskGlobalId: string | null;
  mode: BarDragMode | null;
  liveStartMs: number;
  liveFinishMs: number;
}

export interface UseGanttBarDragOptions {
  range: ScheduleTimeRange | null;
  pixelWidth: number;
  scale: GanttTimeScale;
}

export interface UseGanttBarDragResult {
  /** Call on pointerdown on a bar or its edge hit-zone. */
  onPointerDown: (
    e: React.PointerEvent<SVGElement>,
    taskGlobalId: string,
    mode: BarDragMode,
  ) => void;
  /** Live drag state — render the floating tooltip from this. */
  live: BarDragLive;
}

export function useGanttBarDrag(opts: UseGanttBarDragOptions): UseGanttBarDragResult {
  const { range, pixelWidth, scale } = opts;
  const sessionRef = useRef<DragSession | null>(null);
  const [live, setLive] = useState<BarDragLive>({
    taskGlobalId: null, mode: null, liveStartMs: 0, liveFinishMs: 0,
  });

  const endDrag = useCallback((commit: boolean) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const store = useViewerStore.getState();
    if (commit) {
      store.endScheduleTransaction();
      if (sess.resumePlayback) store.playSchedule();
    } else {
      store.abortScheduleTransaction();
      // Abort is a full rollback; don't resume playback even if it was
      // on at begin — user may have hit Esc specifically because the
      // animation was running and they wanted to stop editing.
    }
    sessionRef.current = null;
    setLive({ taskGlobalId: null, mode: null, liveStartMs: 0, liveFinishMs: 0 });
  }, []);

  // Global handlers — attached once per session on pointerdown,
  // detached on up / cancel / esc. Using window-level handlers (not
  // React's pointermove on the svg) means a drag that exits the
  // timeline bounds still tracks the cursor.
  const onPointerMove = useCallback((e: PointerEvent) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const rawDelta = (e.clientX - sess.startClientX) / (sess.pxPerMs || 1);
    // Shift disables snap for precise placement.
    const unit = e.shiftKey ? 1 : (SNAP_MS_BY_SCALE[scale] ?? 60_000);
    const snapped = snapDeltaMs(rawDelta, unit);

    let liveStart = sess.originalStartMs;
    let liveFinish = sess.originalFinishMs;
    switch (sess.mode) {
      case 'shift':
        liveStart = sess.originalStartMs + snapped;
        liveFinish = sess.originalFinishMs + snapped;
        break;
      case 'resize-start':
        liveStart = sess.originalStartMs + snapped;
        // Guard: start can't cross finish. Clamp to finish - 1 snap unit.
        if (liveStart >= sess.originalFinishMs) {
          liveStart = sess.originalFinishMs - unit;
        }
        break;
      case 'resize-finish':
        liveFinish = sess.originalFinishMs + snapped;
        if (liveFinish <= sess.originalStartMs) {
          liveFinish = sess.originalStartMs + unit;
        }
        break;
    }

    sess.liveStartMs = liveStart;
    sess.liveFinishMs = liveFinish;

    // Commit to the store — the transaction open at begin means this
    // fires 60 times a second but lands as ONE undo entry.
    const store = useViewerStore.getState();
    store.updateTaskTime(sess.taskGlobalId, {
      scheduleStart: epochToIso(liveStart),
      scheduleFinish: epochToIso(liveFinish),
      scheduleDuration: msToIsoDuration(liveFinish - liveStart),
    });

    setLive({
      taskGlobalId: sess.taskGlobalId,
      mode: sess.mode,
      liveStartMs: liveStart,
      liveFinishMs: liveFinish,
    });
  }, [scale]);

  const onPointerUp = useCallback(() => {
    detach();
    endDrag(true);
  }, [endDrag]);

  const onPointerCancel = useCallback(() => {
    detach();
    endDrag(false);
  }, [endDrag]);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      detach();
      endDrag(false);
    }
  }, [endDrag]);

  function detach() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
  }

  const onPointerDown = useCallback((
    e: React.PointerEvent<SVGElement>,
    taskGlobalId: string,
    mode: BarDragMode,
  ) => {
    if (!range || pixelWidth <= 0) return;
    // Only primary button — avoid right-click hijack.
    if (e.button !== 0) return;
    const store = useViewerStore.getState();
    const task = store.scheduleData?.tasks.find(t => t.globalId === taskGlobalId);
    if (!task) return;
    const origStart = parseIso(task.taskTime?.scheduleStart);
    const origFinish = parseIso(task.taskTime?.scheduleFinish);
    if (origStart === undefined || origFinish === undefined) return;
    // Don't try to resize a zero-width bar: shift-only instead. Also
    // milestones should never hit this path (caller gates them out) but
    // we defend anyway.
    if (origFinish <= origStart && mode !== 'shift') return;

    e.stopPropagation();
    e.preventDefault();

    const ratio = pxPerMs(pixelWidth, range);
    const resumePlayback = store.playbackIsPlaying;
    if (resumePlayback) store.pauseSchedule();

    // Open a single undo transaction for the whole gesture.
    const label =
      mode === 'shift' ? 'Drag task'
      : mode === 'resize-start' ? 'Resize task start'
      : 'Resize task finish';
    store.beginScheduleTransaction(label);

    sessionRef.current = {
      taskGlobalId,
      mode,
      startClientX: e.clientX,
      pxPerMs: ratio,
      originalStartMs: origStart,
      originalFinishMs: origFinish,
      resumePlayback,
      liveStartMs: origStart,
      liveFinishMs: origFinish,
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);

    setLive({
      taskGlobalId, mode,
      liveStartMs: origStart, liveFinishMs: origFinish,
    });
  }, [range, pixelWidth, onPointerMove, onPointerUp, onPointerCancel, onKeyDown]);

  return { onPointerDown, live };
}
