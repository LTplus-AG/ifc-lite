/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useConstructionSequence — drives the 3D viewport's hidden-entity set from
 * the Gantt playback clock. Tracks which ids we contributed so toggling the
 * animation off restores the user's original visibility choices.
 *
 * Playback tick: a requestAnimationFrame loop advances `playbackTime` when
 * `playbackIsPlaying` is true. Hidden-set updates happen on every playback
 * clock change (explicit scrubs too).
 */

import { useEffect, useRef } from 'react';
import { useViewerStore, computeHiddenProductIds } from '@/store';

export function useConstructionSequence(): void {
  const animationEnabled = useViewerStore(s => s.animationEnabled);
  const isPlaying = useViewerStore(s => s.playbackIsPlaying);
  const playbackTime = useViewerStore(s => s.playbackTime);
  const scheduleData = useViewerStore(s => s.scheduleData);
  const advancePlaybackBy = useViewerStore(s => s.advancePlaybackBy);

  /** expressIds the animation added to hiddenEntities — tracked so we can remove them on disable. */
  const contributedHiddenRef = useRef<Set<number>>(new Set());

  // rAF playback loop — ticks the simulated clock.
  useEffect(() => {
    if (!isPlaying) return;
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
  }, [isPlaying, advancePlaybackBy]);

  // Apply derived visibility / selection on every clock change.
  useEffect(() => {
    const store = useViewerStore.getState();

    if (!animationEnabled || !scheduleData) {
      // Remove anything the animation previously hid.
      if (contributedHiddenRef.current.size > 0) {
        const ids = Array.from(contributedHiddenRef.current);
        store.showEntities(ids);
        contributedHiddenRef.current = new Set();
      }
      return;
    }

    const nextHidden = computeHiddenProductIds(scheduleData, playbackTime);
    const prevHidden = contributedHiddenRef.current;

    // Remove ids we previously hid that shouldn't be hidden now.
    const toShow: number[] = [];
    for (const id of prevHidden) {
      if (!nextHidden.has(id)) toShow.push(id);
    }
    // Add newly-hidden ids.
    const toHide: number[] = [];
    for (const id of nextHidden) {
      if (!prevHidden.has(id)) toHide.push(id);
    }
    if (toShow.length > 0) store.showEntities(toShow);
    if (toHide.length > 0) store.hideEntities(toHide);
    contributedHiddenRef.current = nextHidden;
  }, [animationEnabled, playbackTime, scheduleData]);

  // Clean up on unmount — if the panel is torn down we need to restore
  // visibility so the viewport doesn't get stuck with hidden products.
  useEffect(() => {
    return () => {
      if (contributedHiddenRef.current.size === 0) return;
      const store = useViewerStore.getState();
      store.showEntities(Array.from(contributedHiddenRef.current));
      contributedHiddenRef.current = new Set();
    };
  }, []);
}
