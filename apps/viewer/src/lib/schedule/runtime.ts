/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore, toGlobalIdFromModels, type ForwardModelMapLike } from '@/store';
import { resolveScheduleSourceModelId } from '@/store/slices/schedule-edit-helpers';
import { computeAnimationFrame, type RGBA } from '@/components/viewer/schedule/schedule-animator';
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

const untaskedCache = new WeakMap<readonly unknown[], { length: number; sourceModelId: string | null; ids: Set<number> }>();
function publishScheduleFrame(): void {
  const { animationEnabled, scheduleData, playbackTime, animationSettings, activeWorkScheduleId } = useViewerStore.getState();
    const store = useViewerStore.getState();

    // Animation off / no data → remove our layer (compositor will
    // restore whatever we had hidden/coloured).
    if (!animationEnabled || !scheduleData) {
      store.removeOverlayLayer('animation');
      return;
    }

    const models: ForwardModelMapLike = store.models;
    const activeModelId = store.scheduleSourceModelId ?? store.activeModelId;
    if (models.size > 0 && store.scheduleSourceModelId && !models.has(store.scheduleSourceModelId)) { store.removeOverlayLayer('animation'); return; }

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
      if (meshes && meshes.length > 0) {
        // Every frame needs the same set; resolving each mesh again per frame is 100k+ lookups.
        const cached = untaskedCache.get(meshes);
        if (cached && cached.length === meshes.length && cached.sourceModelId === sourceModelId) {
          allLocalIds = cached.ids;
        } else {
          allLocalIds = new Set<number>();
          for (const mesh of meshes) {
            const ref = store.resolveGlobalIdFromModels(mesh.expressId);
            if (ref?.modelId === sourceModelId) allLocalIds.add(ref.expressId);
          }
          untaskedCache.set(meshes, { length: meshes.length, sourceModelId, ids: allLocalIds });
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
}
let users = 0;
let boundedPlayback = false;
/** Suppress wrapping for one bounded run without editing the user's preference. */
export function holdBoundedSchedulePlayback(): () => void {
  boundedPlayback = true;
  return () => { boundedPlayback = false; };
}
let unsubscribe: (() => void) | null = null;
let animationFrame: number | null = null;
let last: number | null = null;
function syncClock(): void {
  const s = useViewerStore.getState();
  if (!s.playbackIsPlaying || !s.animationEnabled || !s.scheduleData) {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null; last = null; return;
  }
  if (animationFrame !== null) return;
  if (last === null) last = performance.now();
  animationFrame = requestAnimationFrame(now => {
    animationFrame = null; const delta = now - (last ?? now); last = now;
    useViewerStore.getState().advancePlaybackBy(delta, !boundedPlayback); syncClock();
  });
}
/** One ref-counted native clock/overlay runtime for panel and off-panel automation. */
export function acquireScheduleRuntime(): () => void {
  users++;
  if (users === 1) {
    unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (state.animationEnabled !== previous.animationEnabled || state.playbackTime !== previous.playbackTime
        || state.scheduleData !== previous.scheduleData || state.animationSettings !== previous.animationSettings
        || state.activeWorkScheduleId !== previous.activeWorkScheduleId || state.models !== previous.models
        || state.scheduleSourceModelId !== previous.scheduleSourceModelId) publishScheduleFrame();
      syncClock();
    });
    publishScheduleFrame(); syncClock();
  }
  let released = false;
  return () => {
    if (released) return; released = true; users--;
    if (!users) {
      unsubscribe?.(); unsubscribe = null;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null; last = null;
      useViewerStore.getState().removeOverlayLayer('animation');
    }
  };
}
