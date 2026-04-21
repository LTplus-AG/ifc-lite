/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useConstructionSequence — drives the 3D viewport from the Gantt playback
 * clock.
 *
 * Two output channels per frame:
 *   1. **Hidden set** (`visibilitySlice.hiddenEntities`) — products that the
 *      current playback time says should not be visible (upcoming-far +
 *      completed demolitions).
 *   2. **Color overrides** (`dataSlice.pendingColorUpdates`) — per-entity
 *      RGBA drives the lifecycle colouring in `style === 'phased'`. Lifts
 *      into `scene.setColorOverrides()` via the existing lens-pipeline.
 *
 * Invariants:
 *   • **Federation-awareness.** The animator returns local `productExpressIds`.
 *     The renderer/visibility layer operates on global IDs. We translate via
 *     `toGlobalIdFromModels` before writing.
 *   • **Don't clobber user-hidden IDs.** On toggle-off / unmount we only
 *     reveal IDs we hid ourselves *and* that weren't already hidden by the
 *     user. Tracked via `Map<id, wasHidden>`.
 *   • **Don't clobber lens colour overrides.** We only write
 *     `pendingColorUpdates` when phased animation is active; on toggle-off
 *     we clear so the lens or material default takes over.
 *
 * Playback tick: a requestAnimationFrame loop advances `playbackTime` when
 * `playbackIsPlaying` && `animationEnabled` are both true.
 */

import { useEffect, useRef } from 'react';
import {
  useViewerStore,
  toGlobalIdFromModels,
  type ForwardModelMapLike,
} from '@/store';
import { computeAnimationFrame, type RGBA } from './schedule-animator';

/**
 * Map the schedule's local product expressIds to renderer global IDs.
 *
 * Schedule extraction is per-model (the schedule-adapter caches one
 * extraction per active model), so every local expressId is attributed to
 * that model. Federation-aware per-product attribution — tasks whose
 * `productExpressIds` span multiple models — would require extending
 * `ScheduleExtraction` with a source-model field; explicit follow-up.
 */
function localIdsToGlobal<T>(
  localMap: Map<number, T> | Set<number>,
  models: ForwardModelMapLike,
  activeModelId: string | null | undefined,
): Map<number, T> | Set<number> {
  const sourceModelId = activeModelId
    ?? (models.size === 1 ? (models.keys().next().value ?? '') : '');

  if (localMap instanceof Set) {
    const out = new Set<number>();
    for (const local of localMap) {
      out.add(toGlobalIdFromModels(models, sourceModelId, local));
    }
    return out;
  }
  const out = new Map<number, T>();
  for (const [local, v] of localMap) {
    out.set(toGlobalIdFromModels(models, sourceModelId, local), v);
  }
  return out;
}

export function useConstructionSequence(): void {
  const animationEnabled = useViewerStore(s => s.animationEnabled);
  const isPlaying = useViewerStore(s => s.playbackIsPlaying);
  const playbackTime = useViewerStore(s => s.playbackTime);
  const scheduleData = useViewerStore(s => s.scheduleData);
  const activeWorkScheduleId = useViewerStore(s => s.activeWorkScheduleId);
  const advancePlaybackBy = useViewerStore(s => s.advancePlaybackBy);
  const animationSettings = useViewerStore(s => s.animationSettings);

  /** Each entry is a GLOBAL id we hid; flag = "was already hidden by user". */
  const contributedHiddenRef = useRef<Map<number, boolean>>(new Map());
  /** Global ids for which we last wrote colour overrides. Used on cleanup. */
  const contributedColorsRef = useRef<Set<number>>(new Set());

  // rAF playback loop — ticks the simulated clock.
  useEffect(() => {
    if (!isPlaying || !animationEnabled) return;
    let frame: number | null = null;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      advancePlaybackBy(delta);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [isPlaying, animationEnabled, advancePlaybackBy]);

  // Apply derived visibility + colour on every playback / settings change.
  useEffect(() => {
    const store = useViewerStore.getState();

    const filterOwnedToShow = (ids: Iterable<number>): number[] => {
      const out: number[] = [];
      for (const id of ids) {
        if (contributedHiddenRef.current.get(id) === false) out.push(id);
      }
      return out;
    };

    // ── Animation off: restore owned visibility + clear colour overrides ──
    if (!animationEnabled || !scheduleData) {
      if (contributedHiddenRef.current.size > 0) {
        const toShow = filterOwnedToShow(contributedHiddenRef.current.keys());
        if (toShow.length > 0) store.showEntities(toShow);
        contributedHiddenRef.current = new Map();
      }
      if (contributedColorsRef.current.size > 0) {
        // `new Map()` signals "clear overlays" to useGeometryStreaming.
        store.setPendingColorUpdates(new Map());
        contributedColorsRef.current = new Set();
      }
      return;
    }

    // `store.models` already satisfies `ForwardModelMapLike` — no cast
    // required once we stop narrowing it to a plain Map at the boundary.
    const models: ForwardModelMapLike = store.models;
    const activeModelId = store.activeModelId;

    // Animator is now a single source of truth — it always emits hiddenIds
    // (so `minimal` still removes demolished products and hides upcoming
    // ones) and only emits colour overrides when style === 'phased'.
    const frame = computeAnimationFrame(
      scheduleData, playbackTime, animationSettings, activeWorkScheduleId || null,
    );
    const nextLocalHidden: Set<number> = frame.hiddenIds;
    const nextLocalColors: Map<number, RGBA> = frame.colorOverrides;

    const nextHidden = localIdsToGlobal(nextLocalHidden, models, activeModelId) as Set<number>;
    const nextColors = localIdsToGlobal(nextLocalColors, models, activeModelId) as Map<number, RGBA>;

    // ── Reconcile hidden set ──────────────────────────────────────────
    const prev = contributedHiddenRef.current;
    const toShow: number[] = [];
    for (const [id, wasHidden] of prev) {
      if (!nextHidden.has(id) && wasHidden === false) toShow.push(id);
    }
    const toHide: number[] = [];
    const nextHiddenMap = new Map<number, boolean>();
    const currentlyHidden = store.hiddenEntities ?? new Set<number>();
    for (const id of nextHidden) {
      if (prev.has(id)) {
        nextHiddenMap.set(id, prev.get(id)!);
      } else {
        const wasHidden = currentlyHidden.has(id);
        nextHiddenMap.set(id, wasHidden);
        if (!wasHidden) toHide.push(id);
      }
    }
    if (toShow.length > 0) store.showEntities(toShow);
    if (toHide.length > 0) store.hideEntities(toHide);
    contributedHiddenRef.current = nextHiddenMap;

    // ── Reconcile colour overrides ────────────────────────────────────
    // Overrides are all-or-nothing per pendingColorUpdates call: the next
    // map is a full replacement. When empty, signal a clear with `new Map()`.
    if (nextColors.size > 0) {
      store.setPendingColorUpdates(nextColors);
      contributedColorsRef.current = new Set(nextColors.keys());
    } else if (contributedColorsRef.current.size > 0) {
      store.setPendingColorUpdates(new Map());
      contributedColorsRef.current = new Set();
    }
  }, [animationEnabled, playbackTime, scheduleData, activeWorkScheduleId, animationSettings]);

  // Unmount cleanup — restore owned visibility + clear our colour overrides.
  useEffect(() => {
    return () => {
      const store = useViewerStore.getState();
      if (contributedHiddenRef.current.size > 0) {
        const toShow: number[] = [];
        for (const [id, wasHidden] of contributedHiddenRef.current) {
          if (wasHidden === false) toShow.push(id);
        }
        if (toShow.length > 0) store.showEntities(toShow);
        contributedHiddenRef.current = new Map();
      }
      if (contributedColorsRef.current.size > 0) {
        store.setPendingColorUpdates(new Map());
        contributedColorsRef.current = new Set();
      }
    };
  }, []);
}
