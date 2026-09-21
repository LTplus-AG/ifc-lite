/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour overlay + row focus (#2867) for a `ValidationReport`, generalised
 * over its source (#5138 plan §5/§6: split out of `useIDS.ts` so the same
 * behaviour renders an IDS report and a rule-set report alike). Paired with
 * `useValidationIsolation.ts` (set-level isolate actions) and
 * `useValidationExports.ts` (JSON/HTML/BCF) by the orchestrating
 * `useValidationResults.ts`.
 *
 * Moved verbatim from `useIDS.ts`'s "Color Actions" / "Row Focus (#2867)"
 * sections — behaviour unchanged, only the report type widened from
 * `IDSValidationReport` to `ValidationReport`.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import type { ValidationReport } from '@ifc-lite/ids';
import { installIdsFocusVisibility } from '../ids-focus-visibility';
import {
  IDS_FOCUS_COLOR,
  buildValidationColorUpdates,
  type ColorTuple,
} from '../ids/idsColorSystem';
import { releaseOwnedIdsFocusVisibility } from '@/lib/ids/visibility-ownership';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import type { IDSFocusMode, IDSDisplayOptions } from '@/store/slices/idsSlice';
import { useToViewerGlobalId } from './toViewerGlobalId';

export interface ValidationColorFocusApi {
  buildColors: (specId?: string, bothHighlights?: boolean) => Map<number, ColorTuple>;
  applyColors: () => void;
  setSpecColors: (specId: string) => void;
  restoreReportColors: () => void;
  clearColors: () => void;
  releaseFocusVisibility: () => void;
  focusEntity: (modelId: string, expressId: number, mode?: IDSFocusMode, zoomToEntity?: boolean) => void;
  clearEntitySelection: () => void;
  setFocusMode: (mode: IDSFocusMode) => void;
}

export interface UseValidationColorFocusParams {
  report: ValidationReport | null;
  displayOptions: IDSDisplayOptions;
  defaultFailedColor: [number, number, number, number];
  defaultPassedColor: [number, number, number, number];
  focusMode: IDSFocusMode;
  isolationScope: 'ids' | 'spec';
  activeSpecificationId: string | null;
  autoApplyColors: boolean;
}

export function useValidationColorFocus(params: UseValidationColorFocusParams): ValidationColorFocusApi {
  const { report, displayOptions, defaultFailedColor, defaultPassedColor, focusMode, isolationScope, activeSpecificationId, autoApplyColors } = params;

  const models = useViewerStore((s) => s.models);
  const geometryResult = useViewerStore((s) => s.geometryResult);
  const setPendingColorUpdates = useViewerStore((s) => s.setPendingColorUpdates);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntity = useViewerStore((s) => s.setSelectedEntity);
  const setIdsActiveEntity = useViewerStore((s) => s.setIdsActiveEntity);
  const setIdsFocusMode = useViewerStore((s) => s.setIdsFocusMode);
  const setIdsIsolateMode = useViewerStore((s) => s.setIdsIsolateMode);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);

  const toViewerGlobalId = useToViewerGlobalId();
  const originalColorsRef = useRef<Map<number, ColorTuple>>(new Map());
  const geometryResultRef = useRef(geometryResult);
  geometryResultRef.current = geometryResult;

  const buildColors = useCallback(
    (specId?: string, bothHighlights = false): Map<number, ColorTuple> => {
      if (!report) return new Map<number, ColorTuple>();
      const opts = bothHighlights
        ? { ...displayOptions, highlightFailed: true, highlightPassed: true }
        : displayOptions;
      return buildValidationColorUpdates(
        report, models, opts, defaultFailedColor, defaultPassedColor,
        geometryResultRef.current, originalColorsRef.current,
        specId ? { specId } : undefined,
      );
    },
    [report, models, displayOptions, defaultFailedColor, defaultPassedColor],
  );

  const applyColors = useCallback(() => {
    const colorUpdates = buildColors();
    if (colorUpdates.size > 0) setPendingColorUpdates(colorUpdates);
  }, [buildColors, setPendingColorUpdates]);

  const setSpecColors = useCallback((specId: string) => {
    setPendingColorUpdates(buildColors(specId, true));
  }, [buildColors, setPendingColorUpdates]);

  const restoreReportColors = useCallback(() => {
    if (!report) return;
    setPendingColorUpdates(buildColors());
  }, [report, buildColors, setPendingColorUpdates]);

  const clearColors = useCallback(() => {
    setPendingColorUpdates(new Map());
    originalColorsRef.current.clear();
  }, [setPendingColorUpdates]);

  const installFocusIsolation = useCallback((ids: Set<number>): void => {
    const state = useViewerStore.getState();
    const installed = new Set(resolvePresentationIds(state.cameraCallbacks.resolveHighlightIds, [...ids]));
    installIdsFocusVisibility('isolate', installed);
  }, []);

  const installFocusGhost = useCallback((ids: Set<number>): void => {
    const state = useViewerStore.getState();
    const installed = new Set(resolvePresentationIds(state.cameraCallbacks.resolveHighlightIds, [...ids]));
    installIdsFocusVisibility('ghost', installed);
  }, []);

  const releaseFocusVisibility = useCallback((): void => {
    releaseOwnedIdsFocusVisibility(useViewerStore.getState());
  }, []);

  const paintFocus = useCallback((focusedGlobalId: number | null): void => {
    if (!report) return;
    const colors = isolationScope === 'spec' && activeSpecificationId
      ? buildColors(activeSpecificationId, true)
      : buildColors();
    if (focusedGlobalId != null) colors.set(focusedGlobalId, IDS_FOCUS_COLOR);
    setPendingColorUpdates(colors);
  }, [report, isolationScope, activeSpecificationId, buildColors, setPendingColorUpdates]);

  const applyFocusMode = useCallback((globalId: number, mode: IDSFocusMode): void => {
    if (mode === 'highlight') {
      releaseFocusVisibility();
      return;
    }
    if (mode === 'isolate') installFocusIsolation(new Set([globalId]));
    else installFocusGhost(new Set([globalId]));
    setIdsIsolateMode(null);
  }, [releaseFocusVisibility, installFocusIsolation, installFocusGhost, setIdsIsolateMode]);

  const focusEntity = useCallback((
    modelId: string,
    expressId: number,
    mode: IDSFocusMode = focusMode,
    zoomToEntity = true,
  ) => {
    setIdsActiveEntity({ modelId, expressId });

    const isLegacyMode = modelId === '__legacy__' || modelId === 'legacy' || models.size === 0;
    if (isLegacyMode) {
      setSelectedEntityId(expressId);
      setSelectedEntity({ modelId: 'legacy', expressId });
    } else {
      const federatedId = toViewerGlobalId(modelId, expressId);
      if (federatedId == null) return;
      setSelectedEntityId(federatedId);
      setSelectedEntity({ modelId, expressId });
    }

    const globalId = toViewerGlobalId(modelId, expressId);
    if (globalId != null) {
      applyFocusMode(globalId, mode);
      paintFocus(globalId);
    }

    if (zoomToEntity && cameraCallbacks.frameSelection) {
      setTimeout(() => { cameraCallbacks.frameSelection?.(); }, 50);
    }
  }, [
    focusMode, setIdsActiveEntity, setSelectedEntityId, setSelectedEntity, models,
    cameraCallbacks, toViewerGlobalId, applyFocusMode, paintFocus,
  ]);

  const setFocusMode = useCallback((mode: IDSFocusMode) => {
    setIdsFocusMode(mode);
    const active = useViewerStore.getState().idsActiveEntityId;
    if (active) focusEntity(active.modelId, active.expressId, mode, false);
  }, [setIdsFocusMode, focusEntity]);

  const clearEntitySelection = useCallback(() => {
    setIdsActiveEntity(null);
    setSelectedEntityId(null);
    setSelectedEntity(null);
    releaseFocusVisibility();
    paintFocus(null);
  }, [setIdsActiveEntity, setSelectedEntityId, setSelectedEntity, releaseFocusVisibility, paintFocus]);

  const applyColorsRef = useRef(applyColors);
  applyColorsRef.current = applyColors;
  useEffect(() => {
    if (autoApplyColors && report) applyColorsRef.current();
  }, [autoApplyColors, report]);

  return {
    buildColors, applyColors, setSpecColors, restoreReportColors, clearColors,
    releaseFocusVisibility, focusEntity, clearEntitySelection, setFocusMode,
  };
}
