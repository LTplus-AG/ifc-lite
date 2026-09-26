/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS (Information Delivery Specification) hook.
 *
 * Owns the IDS-only lifecycle: load/parse an IDS document, audit it, run
 * validation against a loaded model, and the panel-visibility/locale UI
 * state. The REPORT-DRIVEN behaviour — focus, isolate, colour overlay,
 * filter mode, exports — is generalised over `ValidationReport.source`
 * (#5138 plan §5/§6) and lives in `hooks/validation/useValidationResults.ts`,
 * shared with the rule-set ("information validation") side; this hook
 * composes it and narrows the shared `report` back to `IDSValidationReport`
 * for `UseIDSResult`'s callers, none of which have changed shape.
 */

import { useCallback, useMemo, useRef } from 'react';
import { captureAnalysisStamp, stampAnalysisReport } from './useAnalysisStaleness';
import { useViewerStore } from '@/store';
import type {
  IDSAuditReport,
  IDSDocument,
  IDSValidationReport,
  IDSModelInfo,
  SupportedLocale,
  ValidationProgress,
} from '@ifc-lite/ids';
import {
  validateIDS,
  isIDSValidationReport,
  createTranslationService,
} from '@ifc-lite/ids';
import { loadIdsContent } from './ids/loadIdsContent';
import type { IDSBCFExportSettings, IDSExportProgress } from '@/components/viewer/IDSExportDialog';

import { createDataAccessor } from './ids/idsDataAccessor';
import {
  snapshotPropertyOverlay,
  snapshotEntityVisibility,
} from '@/lib/ids/property-overlay-snapshot';
import { canUseIdsWorker } from './ids/canUseIdsWorker';
import { resolveValidationTarget, type IdsErrorState } from './ids/resolveValidationTarget';
import { runValidationInWorker } from './ids/idsWorkerClient';
import { DEFAULT_FAILED_COLOR, DEFAULT_PASSED_COLOR } from './ids/idsColorSystem';
import type { IDSFocusMode } from '@/store/slices/idsSlice';
import { posthog } from '../lib/analytics';
import { errorCaptureProps } from '../lib/load-errors';
import { getWholeSourceForWorker } from '@/lib/overlay-parse';
import { useValidationResults, type UseValidationResults } from './validation/useValidationResults';
import { useValidationEpoch } from './validation/useValidationEpoch';

export interface UseIDSOptions {
  /** Automatically apply color overrides after validation */
  autoApplyColors?: boolean;
  /** Color for failed entities [R, G, B, A] (0-1 range) */
  failedColor?: [number, number, number, number];
  /** Color for passed entities [R, G, B, A] (0-1 range) */
  passedColor?: [number, number, number, number];
}

/** Everything `useIDS` adds on top of the generalised `UseValidationResults`:
 *  the IDS document lifecycle, audit, run, and panel/locale UI state. */
export interface UseIDSResult extends Omit<UseValidationResults, 'report'> {
  document: IDSDocument | null;
  auditReport: IDSAuditReport | null;
  auditing: boolean;
  /** Narrowed back to the IDS-typed report — this hook only ever produces one. */
  report: IDSValidationReport | null;
  loading: boolean;
  progress: ValidationProgress | null;
  error: IdsErrorState | null;
  locale: SupportedLocale;
  panelVisible: boolean;

  loadIDS: (xmlContent: string) => void;
  loadIDSFile: (file: File) => Promise<void>;
  clearIDS: () => void;

  runValidation: (targetModelId?: string) => Promise<IDSValidationReport | null>;
  cancelValidation: () => void;
  clearValidation: () => void;

  setPanelVisible: (visible: boolean) => void;
  togglePanel: () => void;
  setLocale: (locale: SupportedLocale) => void;
}

export function useIDS(options: UseIDSOptions = {}): UseIDSResult {
  const {
    autoApplyColors = true,
    failedColor: optionsFailedColor,
    passedColor: optionsPassedColor,
  } = options;
  const defaultFailedColor = optionsFailedColor ?? DEFAULT_FAILED_COLOR;
  const defaultPassedColor = optionsPassedColor ?? DEFAULT_PASSED_COLOR;

  const document = useViewerStore((s) => s.idsDocument);
  const auditReport = useViewerStore((s) => s.idsAuditReport);
  const auditing = useViewerStore((s) => s.idsAuditing);
  const loading = useViewerStore((s) => s.idsLoading);
  const progress = useViewerStore((s) => s.idsProgress);
  const error = useViewerStore((s) => s.idsError);
  const locale = useViewerStore((s) => s.idsLocale);
  const panelVisible = useViewerStore((s) => s.idsPanelVisible);

  const clearIdsDocument = useViewerStore((s) => s.clearIdsDocument);
  const setIdsValidationReport = useViewerStore((s) => s.setIdsValidationReport);
  const clearIdsValidationReport = useViewerStore((s) => s.clearIdsValidationReport);
  const setIdsProgress = useViewerStore((s) => s.setIdsProgress);
  const setIdsPanelVisible = useViewerStore((s) => s.setIdsPanelVisible);
  const toggleIdsPanel = useViewerStore((s) => s.toggleIdsPanel);
  const setIdsLoading = useViewerStore((s) => s.setIdsLoading);
  const setIdsError = useViewerStore((s) => s.setIdsError);
  const setIdsLocale = useViewerStore((s) => s.setIdsLocale);
  const getMutationView = useViewerStore((s) => s.getMutationView);

  const models = useViewerStore((s) => s.models);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const activeModelId = useViewerStore((s) => s.activeModelId);

  const results = useValidationResults({
    autoApplyColors, failedColor: defaultFailedColor, passedColor: defaultPassedColor, locale,
  });
  // The store slot is generalised (#5138); `useIDS` only ever PRODUCES an IDS
  // report (the rule-set engine writes through `useInformationValidation`
  // instead), so narrow back here once for every IDS-facing caller.
  const report = results.report && isIDSValidationReport(results.report) ? results.report : null;

  // Per-call supersession guard for `runValidation()` (#2802): each call
  // captures its own epoch and every store write after an `await` checks it
  // is still the most recent call before landing, so a superseded run can
  // never resurrect a stale report or clobber a newer one's `finally`.
  const { bump: bumpEpoch, stillWanted } = useValidationEpoch();
  const workerAbortRef = useRef<AbortController | null>(null);

  const cancelValidation = useCallback(() => {
    bumpEpoch();
    workerAbortRef.current?.abort();
    workerAbortRef.current = null;
    setIdsLoading(false);
    setIdsProgress(null);
    setIdsError(null);
  }, [bumpEpoch, setIdsLoading, setIdsProgress, setIdsError]);

  const translator = useMemo(() => createTranslationService(locale), [locale]);

  const loadIDS = useCallback((xmlContent: string) => {
    loadIdsContent(useViewerStore, xmlContent);
  }, []);

  const loadIDSFile = useCallback(async (file: File) => {
    try {
      setIdsLoading(true);
      setIdsError(null);
      const content = await file.text();
      loadIDS(content);
    } catch (err) {
      setIdsError(err instanceof Error ? err.message : 'Failed to read IDS file');
    } finally {
      setIdsLoading(false);
    }
  }, [loadIDS, setIdsLoading, setIdsError]);

  const clearIDS = useCallback(() => {
    cancelValidation();
    clearIdsDocument();
  }, [cancelValidation, clearIdsDocument]);

  const runValidation = useCallback(async (targetModelId?: string): Promise<IDSValidationReport | null> => {
    if (!document) {
      setIdsError('No IDS document loaded');
      return null;
    }
    const target = resolveValidationTarget({ targetModelId, activeModelId, models, legacyDataStore: ifcDataStore });
    if ('error' in target) {
      setIdsError(target.error);
      return null;
    }
    const { modelId, dataStore } = target;
    const myEpoch = bumpEpoch();
    workerAbortRef.current?.abort();
    const abortController = new AbortController();
    workerAbortRef.current = abortController;
    const stamp = captureAnalysisStamp();

    try {
      setIdsLoading(true);
      setIdsError(null);
      setIdsProgress({
        phase: 'filtering', specificationIndex: 0, totalSpecifications: document.specifications.length,
        entitiesProcessed: 0, totalEntities: 0, percentage: 0,
      });

      // Force the loading state to actually paint before the heavy work
      // below, racing the frame wait against a timer so a backgrounded tab
      // (rAF paused) can't stall the run.
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        requestAnimationFrame(() => requestAnimationFrame(done));
        setTimeout(done, 200);
      });
      if (!stillWanted(myEpoch)) return null;

      const schemaVersion = dataStore.schemaVersion || 'IFC4';
      let lastProgressUpdate = 0;
      const onProgress = (p: ValidationProgress) => {
        if (!stillWanted(myEpoch)) return;
        const now = performance.now();
        if (p.phase === 'complete' || now - lastProgressUpdate >= 120) {
          lastProgressUpdate = now;
          setIdsProgress(p);
        }
      };

      let validationReport: IDSValidationReport | null = null;

      // A model with in-memory property edits (e.g. an IDS correction, #3929)
      // must validate against THOSE edits — the worker re-parses raw source
      // bytes, so it is handed a snapshot of the same overlay projection the
      // main-thread accessor applies (#3946). A deleted or overlay-created
      // entity needs the same treatment (#5184): the re-parsed store still
      // has the deleted entity's bytes and lacks the created one's.
      const mutationView = getMutationView(modelId);
      const propertyOverlay = mutationView?.hasPendingChanges() ? snapshotPropertyOverlay(mutationView) : undefined;
      const entityVisibility = mutationView?.hasPendingChanges() ? snapshotEntityVisibility(mutationView) : undefined;

      if (canUseIdsWorker(dataStore)) {
        try {
          validationReport = await runValidationInWorker({
            source: getWholeSourceForWorker(dataStore),
            document, schemaVersion, modelId, locale,
            includePassingEntities: true, propertyOverlay, entityVisibility, onProgress,
            signal: abortController.signal,
          });
        } catch (workerErr) {
          if (!stillWanted(myEpoch)) return null;
          console.warn('[IDS] Worker validation failed; falling back to main thread.', workerErr);
        }
      }

      if (!validationReport) {
        const accessor = createDataAccessor(dataStore, modelId, mutationView);
        const modelInfo: IDSModelInfo = {
          modelId, schemaVersion, entityCount: dataStore.entityCount || accessor.getAllEntityIds().length,
        };
        validationReport = await validateIDS(document, accessor, modelInfo, {
          translator, onProgress, includePassingEntities: true,
        });
      }

      // A newer call may have started (and even published) while this one
      // awaited the worker/main-thread validation above (#2802).
      if (!stillWanted(myEpoch)) return null;
      setIdsValidationReport(stampAnalysisReport(validationReport, stamp));

      posthog.capture('ids_validation_completed', {
        total_specifications: validationReport.summary.totalSpecifications,
        passed_specifications: validationReport.summary.passedSpecifications,
        failed_specifications: validationReport.summary.failedSpecifications,
        total_entities_checked: validationReport.summary.totalEntitiesChecked,
        overall_pass_rate: validationReport.summary.overallPassRate,
      });
      console.info(
        `[IDS] Validation: ${validationReport.summary.passedSpecifications}/${validationReport.summary.totalSpecifications} specs, ` +
        `${validationReport.summary.totalEntitiesPassed}/${validationReport.summary.totalEntitiesChecked} entities (${validationReport.summary.overallPassRate}%)`,
      );
      return validationReport;
    } catch (err) {
      if (!stillWanted(myEpoch)) return null;
      const message = err instanceof Error ? err.message : 'Validation failed';
      setIdsError(message);
      posthog.captureException(err, { context: 'ids_validation', ...errorCaptureProps(err) });
      console.error('[IDS] Validation error:', err);
      return null;
    } finally {
      if (workerAbortRef.current === abortController) workerAbortRef.current = null;
      // A superseded call must not report itself as no-longer-loading — the
      // call that superseded it is the one actually in flight (#2802).
      if (stillWanted(myEpoch)) setIdsLoading(false);
    }
  }, [
    document, ifcDataStore, models, activeModelId, translator, locale, getMutationView,
    setIdsLoading, setIdsError, setIdsProgress, setIdsValidationReport, bumpEpoch, stillWanted,
  ]);

  const clearValidation = useCallback(() => {
    cancelValidation();
    clearIdsValidationReport();
  }, [cancelValidation, clearIdsValidationReport]);

  const setPanelVisible = useCallback((visible: boolean) => { setIdsPanelVisible(visible); }, [setIdsPanelVisible]);
  const togglePanel = useCallback(() => { toggleIdsPanel(); }, [toggleIdsPanel]);
  const setLocale = useCallback((newLocale: SupportedLocale) => { setIdsLocale(newLocale); }, [setIdsLocale]);

  return {
    ...results,
    report,
    document, auditReport, auditing, loading, progress, error, locale, panelVisible,
    loadIDS, loadIDSFile, clearIDS,
    runValidation, cancelValidation, clearValidation,
    setPanelVisible, togglePanel, setLocale,
  };
}

export type { IDSFocusMode, IDSBCFExportSettings, IDSExportProgress };
