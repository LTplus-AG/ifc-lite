/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Report-driven behaviour for a `ValidationReport` (#5138 plan §5/§6),
 * generalised over its source: focus/isolate/colours/filter mode/exports,
 * the part of `useIDS.ts` that only ever reads the landed report and never
 * cares whether it came from an IDS document or a rule set. `useIDS` keeps
 * document load/audit/run and composes this hook; `useInformationValidation`
 * (rule-set side, #5138 PR 4) composes it too, so both panels' results view
 * (`IDSPanelResults`) is driven by the exact same object shape.
 *
 * Orchestrates three split-out pieces (each independently under the
 * module-size cap): `useValidationColorFocus` (row focus + colour overlay),
 * `useValidationIsolation` (set-level isolate actions), and
 * `useValidationExports` (JSON/HTML/BCF).
 */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';
import type { ValidationReport, SupportedLocale, SetResult } from '@ifc-lite/ids';
import type { IDSFocusMode, IDSDisplayOptions, IDSFilterMode, IDSIsolationScope, IDSIsolateMode } from '@/store/slices/idsSlice';
import { DEFAULT_FAILED_COLOR, DEFAULT_PASSED_COLOR } from '../ids/idsColorSystem';
import { useValidationColorFocus } from './useValidationColorFocus';
import { useValidationIsolation } from './useValidationIsolation';
import { useValidationExports, type ValidationExportsApi } from './useValidationExports';

export interface UseValidationResultsOptions {
  autoApplyColors?: boolean;
  failedColor?: [number, number, number, number];
  passedColor?: [number, number, number, number];
  locale?: SupportedLocale;
}

export interface UseValidationResults extends ValidationExportsApi {
  report: ValidationReport | null;
  activeSpecificationId: string | null;
  activeEntityId: { modelId: string; expressId: number } | null;
  filterMode: IDSFilterMode;
  isolationScope: IDSIsolationScope;
  isolateMode: IDSIsolateMode;
  focusMode: IDSFocusMode;
  isolationActive: boolean;
  visibilityFilterActive: boolean;
  displayOptions: IDSDisplayOptions;

  setActiveSpecification: (specId: string | null) => void;
  focusEntity: (modelId: string, expressId: number, mode?: IDSFocusMode, zoomToEntity?: boolean) => void;
  clearEntitySelection: () => void;
  setFilterMode: (mode: IDSFilterMode) => void;
  setIsolationScope: (scope: IDSIsolationScope) => void;
  setFocusMode: (mode: IDSFocusMode) => void;
  setDisplayOptions: (options: Partial<IDSDisplayOptions>) => void;

  applyColors: () => void;
  clearColors: () => void;

  isolateFailed: () => void;
  isolatePassed: () => void;
  isolateInvolved: (specId?: string) => void;
  isolateSetMembers: (members: SetResult['members']) => void;
  clearIsolation: () => void;

  getFailedEntityIds: (specId?: string) => Array<{ modelId: string; expressId: number }>;
  getPassedEntityIds: (specId?: string) => Array<{ modelId: string; expressId: number }>;
  isEntityFailed: (modelId: string, expressId: number) => boolean;
  isEntityPassed: (modelId: string, expressId: number) => boolean;
}

export function useValidationResults(options: UseValidationResultsOptions = {}): UseValidationResults {
  const {
    autoApplyColors = true,
    failedColor: optionsFailedColor,
    passedColor: optionsPassedColor,
    locale: optionsLocale,
  } = options;
  const defaultFailedColor = optionsFailedColor ?? DEFAULT_FAILED_COLOR;
  const defaultPassedColor = optionsPassedColor ?? DEFAULT_PASSED_COLOR;

  const report = useViewerStore((s) => s.idsValidationReport);
  const storeLocale = useViewerStore((s) => s.idsLocale);
  const locale = optionsLocale ?? storeLocale;
  const activeSpecificationId = useViewerStore((s) => s.idsActiveSpecificationId);
  const activeEntityId = useViewerStore((s) => s.idsActiveEntityId);
  const filterMode = useViewerStore((s) => s.idsFilterMode);
  const isolationScope = useViewerStore((s) => s.idsIsolationScope);
  const isolateMode = useViewerStore((s) => s.idsIsolateMode);
  const focusMode = useViewerStore((s) => s.idsFocusMode);
  const displayOptions = useViewerStore((s) => s.idsDisplayOptions);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const ghostExceptEntities = useViewerStore((s) => s.ghostExceptEntities);
  const idsFailedEntityIds = useViewerStore((s) => s.idsFailedEntityIds);
  const idsPassedEntityIds = useViewerStore((s) => s.idsPassedEntityIds);

  const setIdsFilterMode = useViewerStore((s) => s.setIdsFilterMode);
  const setIdsDisplayOptions = useViewerStore((s) => s.setIdsDisplayOptions);

  const colorFocus = useValidationColorFocus({
    report, displayOptions, defaultFailedColor, defaultPassedColor,
    focusMode, isolationScope, activeSpecificationId, autoApplyColors,
  });
  const isolation = useValidationIsolation({
    isolationScope, activeSpecificationId,
    buildColors: colorFocus.buildColors,
    setSpecColors: colorFocus.setSpecColors,
    restoreReportColors: colorFocus.restoreReportColors,
  });
  const exports = useValidationExports(report, locale);

  const getFailedEntityIds = useCallback((specId?: string): Array<{ modelId: string; expressId: number }> => {
    if (!report) return [];
    const out: Array<{ modelId: string; expressId: number }> = [];
    for (const specResult of report.specificationResults) {
      if (specId && specResult.specification.id !== specId) continue;
      for (const e of specResult.entityResults) if (!e.passed) out.push({ modelId: e.modelId, expressId: e.expressId });
    }
    return out;
  }, [report]);

  const getPassedEntityIds = useCallback((specId?: string): Array<{ modelId: string; expressId: number }> => {
    if (!report) return [];
    const out: Array<{ modelId: string; expressId: number }> = [];
    for (const specResult of report.specificationResults) {
      if (specId && specResult.specification.id !== specId) continue;
      for (const e of specResult.entityResults) if (e.passed) out.push({ modelId: e.modelId, expressId: e.expressId });
    }
    return out;
  }, [report]);

  const isEntityFailed = useCallback(
    (modelId: string, expressId: number): boolean => idsFailedEntityIds.has(`${modelId}:${expressId}`),
    [idsFailedEntityIds],
  );
  const isEntityPassed = useCallback(
    (modelId: string, expressId: number): boolean => idsPassedEntityIds.has(`${modelId}:${expressId}`),
    [idsPassedEntityIds],
  );

  return {
    report, activeSpecificationId, activeEntityId, filterMode, isolationScope, isolateMode, focusMode,
    isolationActive: isolatedEntities != null,
    visibilityFilterActive: isolatedEntities != null || ghostExceptEntities != null,
    displayOptions,

    setActiveSpecification: isolation.setActiveSpecification,
    focusEntity: colorFocus.focusEntity,
    clearEntitySelection: colorFocus.clearEntitySelection,
    setFilterMode: setIdsFilterMode,
    setIsolationScope: isolation.setIsolationScope,
    setFocusMode: colorFocus.setFocusMode,
    setDisplayOptions: setIdsDisplayOptions,

    applyColors: colorFocus.applyColors,
    clearColors: colorFocus.clearColors,

    isolateFailed: isolation.isolateFailed,
    isolatePassed: isolation.isolatePassed,
    isolateInvolved: isolation.isolateInvolved,
    isolateSetMembers: isolation.isolateSetMembers,
    clearIsolation: isolation.clearIsolation,

    getFailedEntityIds, getPassedEntityIds, isEntityFailed, isEntityPassed,

    ...exports,
  };
}
