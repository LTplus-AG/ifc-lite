/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useConstructionSequence — drives the 3D viewport's hidden-entity set from
 * the Gantt playback clock.
 *
 * Two invariants we must preserve:
 *   1. **Federation-awareness.** The schedule extractor returns local
 *      `productExpressIds`. The renderer/visibility slice operates on
 *      global IDs. We translate via `toGlobalIdFromModels` before writing.
 *   2. **Don't clobber user-hidden IDs.** On toggle-off / unmount we must
 *      only reveal IDs we ourselves hid *and* that weren't already hidden
 *      by the user. We remember the pre-hide state in a `Map<id, wasHidden>`.
 *
 * Playback tick: a requestAnimationFrame loop advances `playbackTime` when
 * `playbackIsPlaying` && `animationEnabled` are both true.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore, computeHiddenProductIds, toGlobalIdFromModels } from '@/store';
import type { ScheduleExtraction } from '@ifc-lite/parser';

/**
 * Map the schedule's local product expressIds to renderer global IDs.
 *
 * Schedule extraction is currently per-model (the schedule-adapter caches
 * one extraction per active model), so every local expressId is attributed
 * to that model. Federation-aware per-product attribution — tasks whose
 * `productExpressIds` span multiple models — would require extending
 * `ScheduleExtraction` with a source-model field; that's an explicit
 * follow-up noted in the PR description.
 */
function localHiddenToGlobal(
  localHidden: Set<number>,
  _scheduleData: ScheduleExtraction,
  models: Map<string, { idOffset?: number }>,
  activeModelId: string | null | undefined,
): Set<number> {
  if (localHidden.size === 0) return new Set();
  const sourceModelId = activeModelId
    ?? (models.size === 1 ? (models.keys().next().value ?? '') : '');
  const result = new Set<number>();
  for (const local of localHidden) {
    result.add(toGlobalIdFromModels(models, sourceModelId, local));
  }
  return result;
}

export function useConstructionSequence(): void {
  const animationEnabled = useViewerStore(s => s.animationEnabled);
  const isPlaying = useViewerStore(s => s.playbackIsPlaying);
  const playbackTime = useViewerStore(s => s.playbackTime);
  const scheduleData = useViewerStore(s => s.scheduleData);
  const activeWorkScheduleId = useViewerStore(s => s.activeWorkScheduleId);
  const advancePlaybackBy = useViewerStore(s => s.advancePlaybackBy);

  /**
   * Each entry is a global ID we hid; the boolean records whether the id was
   * ALREADY hidden by the user when we added it. On cleanup we only call
   * `showEntities` for ids where the flag is `false` (= we were the sole hider).
   */
  const contributedHiddenRef = useRef<Map<number, boolean>>(new Map());

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

  // Apply derived visibility on every clock change.
  useEffect(() => {
    const store = useViewerStore.getState();

    /** Filter a toShow list to only ids the hook owns alone. */
    const filterOwnedToShow = (ids: Iterable<number>): number[] => {
      const out: number[] = [];
      for (const id of ids) {
        if (contributedHiddenRef.current.get(id) === false) out.push(id);
      }
      return out;
    };

    if (!animationEnabled || !scheduleData) {
      // Remove only the ids we added that the user hadn't hidden themselves.
      if (contributedHiddenRef.current.size > 0) {
        const toShow = filterOwnedToShow(contributedHiddenRef.current.keys());
        if (toShow.length > 0) store.showEntities(toShow);
        contributedHiddenRef.current = new Map();
      }
      return;
    }

    const localHidden = computeHiddenProductIds(scheduleData, playbackTime, activeWorkScheduleId);
    const nextHidden = localHiddenToGlobal(
      localHidden,
      scheduleData,
      store.models as unknown as Map<string, { idOffset?: number }>,
      store.activeModelId,
    );
    const prev = contributedHiddenRef.current;

    // 1. Reveal owned ids that shouldn't be hidden any more.
    const toShow: number[] = [];
    for (const [id, wasHidden] of prev) {
      if (!nextHidden.has(id) && wasHidden === false) toShow.push(id);
    }

    // 2. Hide newly-scheduled ids — remember whether they were user-hidden.
    const toHide: number[] = [];
    const nextMap = new Map<number, boolean>();
    const currentlyHidden = store.hiddenEntities ?? new Set<number>();
    for (const id of nextHidden) {
      if (prev.has(id)) {
        nextMap.set(id, prev.get(id)!);
      } else {
        const wasHidden = currentlyHidden.has(id);
        nextMap.set(id, wasHidden);
        if (!wasHidden) toHide.push(id);
      }
    }

    if (toShow.length > 0) store.showEntities(toShow);
    if (toHide.length > 0) store.hideEntities(toHide);
    contributedHiddenRef.current = nextMap;
  }, [animationEnabled, playbackTime, scheduleData, activeWorkScheduleId]);

  // Unmount cleanup — restore only what we own.
  useEffect(() => {
    return () => {
      if (contributedHiddenRef.current.size === 0) return;
      const store = useViewerStore.getState();
      const toShow: number[] = [];
      for (const [id, wasHidden] of contributedHiddenRef.current) {
        if (wasHidden === false) toShow.push(id);
      }
      if (toShow.length > 0) store.showEntities(toShow);
      contributedHiddenRef.current = new Map();
    };
  }, []);
}
