/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useMemo, useRef } from 'react';
import { useViewerStore } from '@/store';
import type { ClashFocusMode } from '@/store/slices/clashSlice';
import { clashReviewKey, type Clash, type ClashReviewStatus } from '@ifc-lite/clash';
import {
  elementPairExclusion,
  typeAnyExclusion,
  typePairExclusion,
  type ClashExclusionRule,
} from '@/lib/clash/exclusions';

export type { ClashFocusMode };
export type { ClashBcfConfig, ClashBcfGroupBy } from '@/lib/clash/bcf-export-config';
import { createNativeClashRuntime } from '@/lib/clash/clash-native-runtime';
export function useClash() {
  const result = useViewerStore((s) => s.clashResult);
  const groups = useViewerStore((s) => s.clashGroups);
  const running = useViewerStore((s) => s.clashRunning);
  const error = useViewerStore((s) => s.clashError);
  const progress = useViewerStore((s) => s.clashProgress);
  const mode = useViewerStore((s) => s.clashMode);
  const tolerance = useViewerStore((s) => s.clashTolerance);
  const clearance = useViewerStore((s) => s.clashClearance);
  const groupBy = useViewerStore((s) => s.clashGroupBy);
  const clashPresets = useViewerStore((s) => s.clashPresets);
  const selectedId = useViewerStore((s) => s.clashSelectedId);
  const panelVisible = useViewerStore((s) => s.clashPanelVisible);
  const reviews = useViewerStore((s) => s.clashReviews);
  const statusFilter = useViewerStore((s) => s.clashStatusFilter);
  const exclusions = useViewerStore((s) => s.clashExclusions);
  const exclusionCounts = useViewerStore((s) => s.clashExclusionCounts);
  const suppressedCount = useViewerStore((s) => s.clashSuppressedCount);
  const modelCount = useViewerStore((s) => s.models.size);
  const setMode = useViewerStore((s) => s.setClashMode);
  const setTolerance = useViewerStore((s) => s.setClashTolerance);
  const setClearance = useViewerStore((s) => s.setClashClearance);
  const setGroupBy = useViewerStore((s) => s.setClashGroupBy);
  const setPanelVisible = useViewerStore((s) => s.setClashPanelVisible);
  const setClashReview = useViewerStore((s) => s.setClashReview);
  const addExclusion = useViewerStore((s) => s.addClashExclusion);
  const removeExclusion = useViewerStore((s) => s.removeClashExclusion);
  const setExclusionEnabled = useViewerStore((s) => s.setClashExclusionEnabled);
  const clearExclusions = useViewerStore((s) => s.clearClashExclusions);
  const toggleStatusFilter = useViewerStore((s) => s.toggleClashStatusFilter);
  const runEpochRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);
  const {
    run,
    runAll,
    runMatrix,
    runPreset,
    runDuplicates,
    focusClash,
    focusClashes,
    selectElement,
    highlightAll,
    clearHighlight,
    bcfPreview,
    exportBcf,
    clearAll,
    invalidateSolidCompute,
    cancelRun,
  } = useMemo(() => createNativeClashRuntime({ runEpochRef, runAbortRef }), [runEpochRef, runAbortRef]);
  const reviewOf = useCallback(
    (clash: Clash): ClashReviewStatus => reviews.get(clashReviewKey(clash))?.status ?? 'open',
    [reviews],
  );
  const reviewCommentOf = useCallback(
    (clash: Clash): string => reviews.get(clashReviewKey(clash))?.comment ?? '',
    [reviews],
  );
  const setReview = useCallback(
    (
      clash: Clash,
      patch: {
        status?: ClashReviewStatus;
        comment?: string;
      },
    ) => setClashReview(clashReviewKey(clash), patch),
    [setClashReview],
  );
  const excludeTypePair = useCallback(
    (clash: Clash) => addExclusion(typePairExclusion(clash.a.tag, clash.b.tag)),
    [addExclusion],
  );
  const excludeElementPair = useCallback(
    (clash: Clash) => addExclusion(elementPairExclusion(clash.a, clash.b)),
    [addExclusion],
  );
  const excludeTypeAny = useCallback((tag: string) => addExclusion(typeAnyExclusion(tag)), [addExclusion]);
  const exclusionCountOf = useCallback(
    (rule: ClashExclusionRule): number => exclusionCounts.get(rule.id) ?? 0,
    [exclusionCounts],
  );
  return {
    result,
    groups,
    running,
    error,
    progress,
    mode,
    tolerance,
    clearance,
    groupBy,
    selectedId,
    panelVisible,
    modelCount,
    statusFilter,
    exclusions,
    suppressedCount,
    exclusionCountOf,
    excludeTypePair,
    excludeTypeAny,
    excludeElementPair,
    removeExclusion,
    setExclusionEnabled,
    clearExclusions,
    presets: clashPresets.filter((p) => p.enabled),
    setMode,
    setTolerance,
    setClearance,
    setGroupBy,
    setPanelVisible,
    reviewOf,
    reviewCommentOf,
    setReview,
    toggleStatusFilter,
    run,
    runAll,
    runMatrix,
    runPreset,
    runDuplicates,
    cancelRun,
    focusClash,
    focusClashes,
    selectElement,
    highlightAll,
    clearHighlight,
    exportBcf,
    bcfPreview,
    clearAll,
    invalidateSolidCompute,
  };
}
export {
  CLASH_SUPERSEDED_MESSAGE,
  CLASH_MODEL_UNLOADED_MESSAGE,
  CLASH_REF_UNRESOLVED_MESSAGE,
} from '@/lib/clash/clash-native-focus';
