/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useConstructionSequence — computes the 4D animation frame each playback
 * tick and registers it as the 'animation' overlay layer. The compositor
 * (`useOverlayCompositor`) does the actual write to the renderer.
 *
 * This hook no longer owns visibility reconciliation — that pattern
 * (`contributedHiddenRef` / `contributedColorsRef`) lived here and was
 * duplicated across every channel consumer. After P4 the compositor is
 * the single writer to `hiddenEntities` / `pendingColorUpdates`, so this
 * hook's only job is to emit its desired state as an overlay layer.
 *
 * Invariants:
 *   • **Federation-awareness.** The animator returns local `productExpressIds`.
 *     The renderer operates on global IDs. We translate via
 *     `toGlobalIdFromModels` before registering the layer.
 *
 * Playback tick: a requestAnimationFrame loop advances `playbackTime` when
 * `playbackIsPlaying` && `animationEnabled` are both true.
 */

import { useEffect } from 'react';
import {
  useViewerStore,
  toGlobalIdFromModels,
  type ForwardModelMapLike,
} from '@/store';
import { resolveScheduleSourceModelId } from '@/store/slices/schedule-edit-helpers';
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
  const sourceModelId = resolveScheduleSourceModelId(models, activeModelId);

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

  // Register / update the 'animation' overlay layer on every state change.
  // The compositor hook picks this up and reconciles it into the renderer.
  useEffect(() => {
    const store = useViewerStore.getState();

    // Animation off / no data → remove our layer (compositor will
    // restore whatever we had hidden/coloured).
    if (!animationEnabled || !scheduleData) {
      store.removeOverlayLayer('animation');
      return;
    }

    const models: ForwardModelMapLike = store.models;
    const activeModelId = store.activeModelId;

    // Enumerate the source model's LOCAL expressIds so the animator can
    // hide coverage-gap products (those with no controlling task). We walk
    // meshes rather than the full IFC entity table because only meshed
    // products can visibly "show up" as the material default in the
    // viewport — non-meshed entities don't render regardless.
    //
    // Runs only when the untasked-hide setting is on so we don't pay the
    // mesh-iteration cost on every playback frame when the feature is off.
    let allLocalIds: Set<number> | undefined;
    if (animationSettings.hideUntaskedProducts) {
      const fullModels = store.models;
      const sourceModelId = resolveScheduleSourceModelId(fullModels, activeModelId);
      const sourceModel = sourceModelId ? fullModels.get(sourceModelId) : undefined;
      const meshes = sourceModel?.geometryResult?.meshes;
      const idOffset = sourceModel?.idOffset ?? 0;
      if (meshes && meshes.length > 0) {
        allLocalIds = new Set<number>();
        for (const mesh of meshes) {
          allLocalIds.add(mesh.expressId - idOffset);
        }
      }
    }

    // Animator is a single source of truth — always emits hiddenIds (so
    // `minimal` still removes demolished products and hides upcoming
    // ones) and only emits colour overrides when style === 'phased'.
    const frame = computeAnimationFrame(
      scheduleData, playbackTime, animationSettings, activeWorkScheduleId || null,
      allLocalIds,
    );
    const nextLocalHidden: Set<number> = frame.hiddenIds;
    const nextLocalColors: Map<number, RGBA> = frame.colorOverrides;

    const nextHidden = localIdsToGlobal(nextLocalHidden, models, activeModelId) as Set<number>;
    const nextColors = localIdsToGlobal(nextLocalColors, models, activeModelId) as Map<number, RGBA>;

    store.registerOverlayLayer({
      id: 'animation',
      priority: 100,
      hiddenIds: nextHidden,
      colorOverrides: nextColors.size > 0 ? nextColors : null,
    });
  }, [animationEnabled, playbackTime, scheduleData, activeWorkScheduleId, animationSettings]);

  // Unmount cleanup — drop our layer. The compositor restores whatever
  // we had contributed to the renderer.
  useEffect(() => {
    return () => {
      useViewerStore.getState().removeOverlayLayer('animation');
    };
  }, []);
}
