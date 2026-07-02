/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS (Information Delivery Specification) hook
 *
 * Provides functions to:
 * - Load and parse IDS XML files
 * - Run validation against loaded IFC models
 * - Apply color overrides (red=failed, green=passed)
 * - Sync selection between IDS results and 3D viewer
 * - Isolate failed/passed entities
 */

import { useCallback, useMemo, useEffect, useRef, useState } from 'react';
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
  auditIDSDocument,
  IDSParseError,
  parseIDS,
  validateIDS,
  createTranslationService,
} from '@ifc-lite/ids';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createBCFFromIDSReport, writeBCF } from '@ifc-lite/bcf';
import { downloadBlob } from '@/lib/export/download';
import { loadIdsContent } from './ids/loadIdsContent';
import type { EntityBoundsInput, IDSBCFExportOptions } from '@ifc-lite/bcf';
import type { IDSBCFExportSettings, IDSExportProgress } from '@/components/viewer/IDSExportDialog';
import { getEntityBounds } from '@/utils/viewportUtils';
import { getGlobalRenderer } from '@/hooks/useBCF';

import { createDataAccessor } from './ids/idsDataAccessor';
import { runValidationInWorker, idsWorkerSupported } from './ids/idsWorkerClient';
import {
  DEFAULT_FAILED_COLOR,
  DEFAULT_PASSED_COLOR,
  buildValidationColorUpdates,
  buildRestoreColorUpdates,
} from './ids/idsColorSystem';
import type { ColorTuple } from './ids/idsColorSystem';
import { downloadReportJSON, downloadReportHTML } from './ids/idsExportService';
import { posthog } from '../lib/analytics';

// ============================================================================
// Types
// ============================================================================

export interface UseIDSOptions {
  /** Automatically apply color overrides after validation */
  autoApplyColors?: boolean;
  /** Color for failed entities [R, G, B, A] (0-1 range) */
  failedColor?: [number, number, number, number];
  /** Color for passed entities [R, G, B, A] (0-1 range) */
  passedColor?: [number, number, number, number];
}

export interface UseIDSResult {
  // State
  /** Loaded IDS document */
  document: IDSDocument | null;
  /**
   * Audit report for the loaded IDS document — flags authoring issues
   * surfaced by the document auditor (invalid IFC entities, malformed
   * restrictions, missing required attributes, …). `null` when no
   * document is loaded or the audit is still in flight.
   */
  auditReport: IDSAuditReport | null;
  /** True while the document auditor is running. */
  auditing: boolean;
  /** Validation report */
  report: IDSValidationReport | null;
  /** Loading state */
  loading: boolean;
  /** Validation progress */
  progress: ValidationProgress | null;
  /** Error message */
  error: string | null;
  /** Current locale */
  locale: SupportedLocale;
  /** Panel visibility */
  panelVisible: boolean;
  /** Active specification ID */
  activeSpecificationId: string | null;
  /** Active entity in results */
  activeEntityId: { modelId: string; expressId: number } | null;
  /** Filter mode */
  filterMode: 'all' | 'failed' | 'passed';
  /** Isolation/color scope: whole report ('ids') or active spec only ('spec') */
  isolationScope: 'ids' | 'spec';
  /** Which isolate action is currently applied by IDS (null = none) */
  isolateMode: 'failed' | 'passed' | 'involved' | null;
  /** True when any entity isolation is currently active in the 3D view */
  isolationActive: boolean;
  /** Display options */
  displayOptions: {
    highlightFailed: boolean;
    highlightPassed: boolean;
    failedColor: [number, number, number, number];
    passedColor: [number, number, number, number];
  };

  // Document actions
  /** Load IDS from XML string */
  loadIDS: (xmlContent: string) => void;
  /** Load IDS from file */
  loadIDSFile: (file: File) => Promise<void>;
  /** Clear loaded IDS document */
  clearIDS: () => void;

  // Validation actions
  /** Run validation against current model(s) */
  runValidation: () => Promise<IDSValidationReport | null>;
  /** Clear validation results */
  clearValidation: () => void;

  // Selection actions
  /** Set active specification for filtering */
  setActiveSpecification: (specId: string | null) => void;
  /** Select an entity from results (syncs to 3D view and zooms) */
  selectEntity: (modelId: string, expressId: number, zoomToEntity?: boolean) => void;
  /** Clear entity selection */
  clearEntitySelection: () => void;

  // UI actions
  /** Show/hide IDS panel */
  setPanelVisible: (visible: boolean) => void;
  /** Toggle IDS panel */
  togglePanel: () => void;
  /** Set display locale */
  setLocale: (locale: SupportedLocale) => void;
  /** Set filter mode */
  setFilterMode: (mode: 'all' | 'failed' | 'passed') => void;
  /** Set the isolation/color scope (whole report vs active spec) */
  setIsolationScope: (scope: 'ids' | 'spec') => void;
  /** Update display options */
  setDisplayOptions: (options: Partial<UseIDSResult['displayOptions']>) => void;

  // Color actions
  /** Apply validation colors to 3D view */
  applyColors: () => void;
  /** Clear validation colors */
  clearColors: () => void;

  // Isolation actions
  /** Isolate failed entities (whole report, or active spec when scope = 'spec') */
  isolateFailed: () => void;
  /** Isolate passed entities (whole report, or active spec when scope = 'spec') */
  isolatePassed: () => void;
  /**
   * Isolate the involved entities (passed ∪ failed) and color them
   * (passed green, failed red). Targets the given spec, else the active spec
   * when scope = 'spec', else the whole report.
   */
  isolateInvolved: (specId?: string) => void;
  /** Clear isolation (and restore whole-report colors) */
  clearIsolation: () => void;

  // Utility getters
  /** Get failed entity IDs for current specification or all */
  getFailedEntityIds: (specId?: string) => Array<{ modelId: string; expressId: number }>;
  /** Get passed entity IDs for current specification or all */
  getPassedEntityIds: (specId?: string) => Array<{ modelId: string; expressId: number }>;
  /** Check if an entity failed validation */
  isEntityFailed: (modelId: string, expressId: number) => boolean;
  /** Check if an entity passed validation */
  isEntityPassed: (modelId: string, expressId: number) => boolean;

  // Export actions
  /** Export validation report to JSON */
  exportReportJSON: () => void;
  /** Export validation report to HTML */
  exportReportHTML: () => void;
  /** Export validation report to BCF with configurable options */
  exportReportBCF: (settings: IDSBCFExportSettings) => Promise<void>;
  /** BCF export progress state */
  bcfExportProgress: IDSExportProgress | null;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/** Dark background for BCF snapshot captures */
const SNAPSHOT_CLEAR_COLOR: [number, number, number, number] = [0.102, 0.106, 0.149, 1];

export function useIDS(options: UseIDSOptions = {}): UseIDSResult {
  const {
    autoApplyColors = true,
    failedColor: optionsFailedColor,
    passedColor: optionsPassedColor,
  } = options;

  // Use stable defaults if options not provided
  const defaultFailedColor = optionsFailedColor ?? DEFAULT_FAILED_COLOR;
  const defaultPassedColor = optionsPassedColor ?? DEFAULT_PASSED_COLOR;

  // IDS store state
  const document = useViewerStore((s) => s.idsDocument);
  const auditReport = useViewerStore((s) => s.idsAuditReport);
  const auditing = useViewerStore((s) => s.idsAuditing);
  const report = useViewerStore((s) => s.idsValidationReport);
  const loading = useViewerStore((s) => s.idsLoading);
  const progress = useViewerStore((s) => s.idsProgress);
  const error = useViewerStore((s) => s.idsError);
  const locale = useViewerStore((s) => s.idsLocale);
  const panelVisible = useViewerStore((s) => s.idsPanelVisible);
  const activeSpecificationId = useViewerStore((s) => s.idsActiveSpecificationId);
  const activeEntityId = useViewerStore((s) => s.idsActiveEntityId);
  const filterMode = useViewerStore((s) => s.idsFilterMode);
  const isolationScope = useViewerStore((s) => s.idsIsolationScope);
  const isolateMode = useViewerStore((s) => s.idsIsolateMode);
  const displayOptions = useViewerStore((s) => s.idsDisplayOptions);

  // IDS store actions
  const setIdsDocument = useViewerStore((s) => s.setIdsDocument);
  const clearIdsDocument = useViewerStore((s) => s.clearIdsDocument);
  const setIdsAuditReport = useViewerStore((s) => s.setIdsAuditReport);
  const setIdsAuditing = useViewerStore((s) => s.setIdsAuditing);
  const setIdsValidationReport = useViewerStore((s) => s.setIdsValidationReport);
  const clearIdsValidationReport = useViewerStore((s) => s.clearIdsValidationReport);
  const setIdsProgress = useViewerStore((s) => s.setIdsProgress);
  const setIdsActiveSpecification = useViewerStore((s) => s.setIdsActiveSpecification);
  const setIdsActiveEntity = useViewerStore((s) => s.setIdsActiveEntity);
  const setIdsPanelVisible = useViewerStore((s) => s.setIdsPanelVisible);
  const toggleIdsPanel = useViewerStore((s) => s.toggleIdsPanel);
  const setIdsLoading = useViewerStore((s) => s.setIdsLoading);
  const setIdsError = useViewerStore((s) => s.setIdsError);
  const setIdsLocale = useViewerStore((s) => s.setIdsLocale);
  const setIdsFilterMode = useViewerStore((s) => s.setIdsFilterMode);
  const setIdsIsolationScope = useViewerStore((s) => s.setIdsIsolationScope);
  const setIdsIsolateMode = useViewerStore((s) => s.setIdsIsolateMode);
  const setIdsDisplayOptions = useViewerStore((s) => s.setIdsDisplayOptions);
  const idsFailedEntityIds = useViewerStore((s) => s.idsFailedEntityIds);
  const idsPassedEntityIds = useViewerStore((s) => s.idsPassedEntityIds);
  const getFailedEntitiesForSpec = useViewerStore((s) => s.getFailedEntitiesForSpec);
  const getPassedEntitiesForSpec = useViewerStore((s) => s.getPassedEntitiesForSpec);

  // Viewer state
  const models = useViewerStore((s) => s.models);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const setPendingColorUpdates = useViewerStore((s) => s.setPendingColorUpdates);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntity = useViewerStore((s) => s.setSelectedEntity);
  const setIsolatedEntities = useViewerStore((s) => s.setIsolatedEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const toGlobalId = useViewerStore((s) => s.toGlobalId);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const geometryResult = useViewerStore((s) => s.geometryResult);

  // Ref to store original colors before IDS color overrides
  const originalColorsRef = useRef<Map<number, ColorTuple>>(new Map());

  const toViewerGlobalId = useCallback((modelId: string, expressId: number): number | undefined => {
    if (
      modelId === '__legacy__'
      || modelId === 'legacy'
      || models.size === 0
      || (models.size === 1 && !models.has(modelId))
    ) {
      return expressId;
    }
    if (!models.has(modelId)) {
      return undefined;
    }
    return toGlobalId(modelId, expressId);
  }, [models, toGlobalId]);

  // Ref to access geometryResult without creating callback dependencies (prevents infinite loops)
  const geometryResultRef = useRef(geometryResult);
  geometryResultRef.current = geometryResult;

  // Get translator for current locale
  const translator = useMemo(() => {
    return createTranslationService(locale);
  }, [locale]);

  // ============================================================================
  // Document Actions
  // ============================================================================

  // Extracted to a store-callable helper so the tour demo kit can load a
  // spec without this panel hook mounted (`hooks/ids/loadIdsContent.ts`).
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
      const message = err instanceof Error ? err.message : 'Failed to read IDS file';
      setIdsError(message);
    } finally {
      setIdsLoading(false);
    }
  }, [loadIDS, setIdsLoading, setIdsError]);

  const clearIDS = useCallback(() => {
    clearIdsDocument();
  }, [clearIdsDocument]);

  // ============================================================================
  // Validation Actions
  // ============================================================================

  const runValidation = useCallback(async (): Promise<IDSValidationReport | null> => {
    if (!document) {
      setIdsError('No IDS document loaded');
      return null;
    }

    // Get data store to validate against
    const dataStore = ifcDataStore || (models.size > 0 ? Array.from(models.values())[0]?.ifcDataStore : null);
    if (!dataStore) {
      setIdsError('No IFC model loaded');
      return null;
    }

    // Determine model ID - use '__legacy__' for legacy single-model mode
    const modelId = activeModelId || (models.size > 0 ? Array.from(models.keys())[0] : '__legacy__');

    try {
      setIdsLoading(true);
      setIdsError(null);
      // Paint a "starting" state immediately so the button shows work is
      // underway before the first real progress event arrives.
      setIdsProgress({
        phase: 'filtering',
        specificationIndex: 0,
        totalSpecifications: document.specifications.length,
        entitiesProcessed: 0,
        totalEntities: 0,
        percentage: 0,
      });

      // Force the loading state to actually paint before spawning the
      // worker and doing any heavy synchronous work, so the spinner +
      // initial progress bar are guaranteed on screen immediately. Race
      // the frame wait against a timer so a backgrounded tab (where
      // requestAnimationFrame is paused) can't stall the run.
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        requestAnimationFrame(() => requestAnimationFrame(done));
        setTimeout(done, 200);
      });

      const schemaVersion = dataStore.schemaVersion || 'IFC4';

      // Progress events arrive far faster than React should re-render
      // (per 100 entities / per spec); throttle store updates to ~8/s
      // and always pass the terminal event.
      let lastProgressUpdate = 0;
      const onProgress = (p: ValidationProgress) => {
        const now = performance.now();
        if (p.phase === 'complete' || now - lastProgressUpdate >= 120) {
          lastProgressUpdate = now;
          setIdsProgress(p);
        }
      };

      let validationReport: IDSValidationReport | null = null;

      // Preferred path: validate in a Web Worker so the whole run is off
      // the main thread — the UI stays at full frame rate and progress
      // actually paints. Every other heavy stage (parse, geometry)
      // already runs in a worker; this brings validation in line. Falls
      // back to in-process validation if the worker is unavailable or
      // fails (e.g. no source bytes for non-STEP models).
      const canUseWorker = idsWorkerSupported() && !!dataStore.source && dataStore.source.byteLength > 0;
      if (canUseWorker) {
        try {
          validationReport = await runValidationInWorker({
            source: dataStore.source!,
            document,
            schemaVersion,
            modelId,
            locale,
            includePassingEntities: true,
            onProgress,
          });
        } catch (workerErr) {
          console.warn('[IDS] Worker validation failed; falling back to main thread.', workerErr);
        }
      }

      if (!validationReport) {
        const accessor = createDataAccessor(dataStore, modelId);
        const modelInfo: IDSModelInfo = {
          modelId,
          schemaVersion,
          entityCount: dataStore.entityCount || accessor.getAllEntityIds().length,
        };
        validationReport = await validateIDS(document, accessor, modelInfo, {
          translator,
          onProgress,
          includePassingEntities: true,
        });
      }

      setIdsValidationReport(validationReport);

      posthog.capture('ids_validation_completed', {
        total_specifications: validationReport.summary.totalSpecifications,
        passed_specifications: validationReport.summary.passedSpecifications,
        failed_specifications: validationReport.summary.failedSpecifications,
        total_entities_checked: validationReport.summary.totalEntitiesChecked,
        overall_pass_rate: validationReport.summary.overallPassRate,
      });

      console.info(
        `[IDS] Validation: ${validationReport.summary.passedSpecifications}/${validationReport.summary.totalSpecifications} specs, ` +
        `${validationReport.summary.totalEntitiesPassed}/${validationReport.summary.totalEntitiesChecked} entities (${validationReport.summary.overallPassRate}%)`
      );

      return validationReport;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Validation failed';
      setIdsError(message);
      posthog.captureException(err, { additional_properties: { context: 'ids_validation' } });
      console.error('[IDS] Validation error:', err);
      return null;
    } finally {
      setIdsLoading(false);
    }
  }, [
    document,
    ifcDataStore,
    models,
    activeModelId,
    translator,
    locale,
    setIdsLoading,
    setIdsError,
    setIdsProgress,
    setIdsValidationReport,
  ]);

  const clearValidation = useCallback(() => {
    clearIdsValidationReport();
  }, [clearIdsValidationReport]);

  // ============================================================================
  // Selection Actions
  // ============================================================================

  const selectEntity = useCallback((modelId: string, expressId: number, zoomToEntity = true) => {

    // Update IDS state
    setIdsActiveEntity({ modelId, expressId });

    // Sync to viewer selection
    // Handle legacy mode vs federation mode
    const isLegacyMode = modelId === '__legacy__' || modelId === 'legacy' || models.size === 0;

    if (isLegacyMode) {
      // Legacy mode: globalId equals expressId, use 'legacy' for selection
      setSelectedEntityId(expressId);
      // Use 'legacy' as the modelId for PropertiesPanel compatibility
      setSelectedEntity({ modelId: 'legacy', expressId });
    } else {
      // Federation mode: use the store helper so ID resolution stays centralized.
      const globalId = toViewerGlobalId(modelId, expressId);
      if (globalId == null) return;
      setSelectedEntityId(globalId);
      setSelectedEntity({ modelId, expressId });
    }

    // Zoom to entity after a small delay to ensure selection is processed
    if (zoomToEntity && cameraCallbacks.frameSelection) {
      setTimeout(() => {
        cameraCallbacks.frameSelection?.();
      }, 50);
    }
  }, [setIdsActiveEntity, setSelectedEntityId, setSelectedEntity, models, cameraCallbacks, toViewerGlobalId]);

  const clearEntitySelection = useCallback(() => {
    setIdsActiveEntity(null);
    setSelectedEntityId(null);
    setSelectedEntity(null);
  }, [setIdsActiveEntity, setSelectedEntityId, setSelectedEntity]);

  // ============================================================================
  // UI Actions
  // ============================================================================

  const setPanelVisible = useCallback((visible: boolean) => {
    setIdsPanelVisible(visible);
  }, [setIdsPanelVisible]);

  const togglePanel = useCallback(() => {
    toggleIdsPanel();
  }, [toggleIdsPanel]);

  const setLocale = useCallback((newLocale: SupportedLocale) => {
    setIdsLocale(newLocale);
  }, [setIdsLocale]);

  const setFilterModeAction = useCallback((mode: 'all' | 'failed' | 'passed') => {
    setIdsFilterMode(mode);
  }, [setIdsFilterMode]);

  const setDisplayOptionsAction = useCallback((opts: Partial<UseIDSResult['displayOptions']>) => {
    setIdsDisplayOptions(opts);
  }, [setIdsDisplayOptions]);

  // ============================================================================
  // Color Actions
  // ============================================================================

  // Build the color-override map for the whole report (or a single spec when
  // `specId` is given). `bothHighlights` forces passed+failed coloring
  // regardless of the user's display toggles — used when isolating a spec's
  // involved elements so both green and red show.
  const buildColors = useCallback(
    (specId?: string, bothHighlights = false): Map<number, ColorTuple> => {
      if (!report) return new Map<number, ColorTuple>();
      const opts = bothHighlights
        ? { ...displayOptions, highlightFailed: true, highlightPassed: true }
        : displayOptions;
      return buildValidationColorUpdates(
        report,
        models,
        opts,
        defaultFailedColor,
        defaultPassedColor,
        geometryResultRef.current,
        originalColorsRef.current,
        specId ? { specId } : undefined
      );
    },
    [report, models, displayOptions, defaultFailedColor, defaultPassedColor]
  );

  const applyColors = useCallback(() => {
    const colorUpdates = buildColors();
    if (colorUpdates.size > 0) {
      setPendingColorUpdates(colorUpdates);
    }
  }, [buildColors, setPendingColorUpdates]);

  // Replace the overlay with a single spec's colors (passed green + failed
  // red). Per-spec coloring is what makes the active spec's verdict correct
  // even for entities that pass in another specification.
  const setSpecColors = useCallback((specId: string) => {
    setPendingColorUpdates(buildColors(specId, true));
  }, [buildColors, setPendingColorUpdates]);

  // Restore the default whole-report coloring, replacing any per-spec colors.
  // An empty map clears the overlay when there's nothing to highlight.
  const restoreReportColors = useCallback(() => {
    if (!report) return;
    setPendingColorUpdates(buildColors());
  }, [report, buildColors, setPendingColorUpdates]);

  const clearColors = useCallback(() => {
    // Empty map signals overlay clear immediately.
    setPendingColorUpdates(new Map());
    originalColorsRef.current.clear();
  }, [setPendingColorUpdates]);

  // Ref to store applyColors for stable useEffect (prevents infinite loops)
  const applyColorsRef = useRef(applyColors);
  applyColorsRef.current = applyColors;

  // Auto-apply colors when validation completes
  // Use ref to avoid dependency on applyColors callback which could cause loops
  useEffect(() => {
    if (autoApplyColors && report) {
      applyColorsRef.current();
    }
  }, [autoApplyColors, report]);

  // ============================================================================
  // Isolation Actions
  // ============================================================================

  // Parse a cached "modelId:expressId" key into a renderer global id.
  const keyToGlobalId = useCallback((key: string): number | undefined => {
    const lastColonIndex = key.lastIndexOf(':');
    const modelId = key.substring(0, lastColonIndex);
    const expressId = parseInt(key.substring(lastColonIndex + 1), 10);
    return toViewerGlobalId(modelId, expressId);
  }, [toViewerGlobalId]);

  // Resolve a list of entity refs to a set of renderer global ids.
  const refsToGlobalIds = useCallback(
    (refs: Array<{ modelId: string; expressId: number }>): Set<number> => {
      const ids = new Set<number>();
      for (const { modelId, expressId } of refs) {
        const globalId = toViewerGlobalId(modelId, expressId);
        if (globalId != null) ids.add(globalId);
      }
      return ids;
    },
    [toViewerGlobalId]
  );

  // Collect global ids from a cached "modelId:expressId" key set.
  const keySetToGlobalIds = useCallback((keys: Set<string>): Set<number> => {
    const ids = new Set<number>();
    for (const key of keys) {
      const globalId = keyToGlobalId(key);
      if (globalId != null) ids.add(globalId);
    }
    return ids;
  }, [keyToGlobalId]);

  const isolateFailed = useCallback(() => {
    if (isolationScope === 'spec') {
      if (!activeSpecificationId) return;
      const ids = refsToGlobalIds(getFailedEntitiesForSpec(activeSpecificationId));
      if (ids.size > 0) {
        setIsolatedEntities(ids);
        setSpecColors(activeSpecificationId);
        setIdsIsolateMode('failed');
      }
      return;
    }
    const failedIds = keySetToGlobalIds(idsFailedEntityIds);
    if (failedIds.size > 0) {
      setIsolatedEntities(failedIds);
      setIdsIsolateMode('failed');
    }
  }, [
    isolationScope,
    activeSpecificationId,
    getFailedEntitiesForSpec,
    refsToGlobalIds,
    keySetToGlobalIds,
    idsFailedEntityIds,
    setIsolatedEntities,
    setSpecColors,
    setIdsIsolateMode,
  ]);

  const isolatePassed = useCallback(() => {
    if (isolationScope === 'spec') {
      if (!activeSpecificationId) return;
      const ids = refsToGlobalIds(getPassedEntitiesForSpec(activeSpecificationId));
      if (ids.size > 0) {
        setIsolatedEntities(ids);
        setSpecColors(activeSpecificationId);
        setIdsIsolateMode('passed');
      }
      return;
    }
    const passedIds = keySetToGlobalIds(idsPassedEntityIds);
    if (passedIds.size > 0) {
      setIsolatedEntities(passedIds);
      setIdsIsolateMode('passed');
    }
  }, [
    isolationScope,
    activeSpecificationId,
    getPassedEntitiesForSpec,
    refsToGlobalIds,
    keySetToGlobalIds,
    idsPassedEntityIds,
    setIsolatedEntities,
    setSpecColors,
    setIdsIsolateMode,
  ]);

  const isolateInvolved = useCallback((specId?: string) => {
    const targetSpec = specId ?? (isolationScope === 'spec' ? activeSpecificationId : null);
    if (targetSpec) {
      const ids = refsToGlobalIds([
        ...getFailedEntitiesForSpec(targetSpec),
        ...getPassedEntitiesForSpec(targetSpec),
      ]);
      if (ids.size > 0) {
        setIsolatedEntities(ids);
        setSpecColors(targetSpec);
        setIdsIsolateMode('involved');
      } else {
        // The spec has no applicable entities (not_applicable). There's
        // nothing to isolate, so drop any stale isolation/overlay left by a
        // previously selected spec rather than leaving it on screen while
        // the panel points at this (empty) spec.
        setIsolatedEntities(null);
        restoreReportColors();
        setIdsIsolateMode(null);
      }
      return;
    }
    // Whole report: every applicable entity (passed ∪ failed), colored
    // green/red regardless of the user's display toggles.
    const ids = keySetToGlobalIds(idsFailedEntityIds);
    for (const globalId of keySetToGlobalIds(idsPassedEntityIds)) ids.add(globalId);
    if (ids.size > 0) {
      setIsolatedEntities(ids);
      setPendingColorUpdates(buildColors(undefined, true));
      setIdsIsolateMode('involved');
    }
  }, [
    isolationScope,
    activeSpecificationId,
    getFailedEntitiesForSpec,
    getPassedEntitiesForSpec,
    refsToGlobalIds,
    keySetToGlobalIds,
    idsFailedEntityIds,
    idsPassedEntityIds,
    setIsolatedEntities,
    setSpecColors,
    restoreReportColors,
    setPendingColorUpdates,
    setIdsIsolateMode,
    buildColors,
  ]);

  const clearIsolation = useCallback(() => {
    setIsolatedEntities(null);
    // Returning to "show all" restores the default whole-report coloring,
    // replacing any per-spec green/red applied while isolated.
    restoreReportColors();
    setIdsIsolateMode(null);
  }, [setIsolatedEntities, restoreReportColors, setIdsIsolateMode]);

  const setActiveSpecification = useCallback((specId: string | null) => {
    setIdsActiveSpecification(specId);
    // In per-spec scope, selecting a spec immediately isolates its involved
    // elements (passed green, failed red); deselecting clears isolation.
    if (isolationScope === 'spec') {
      if (specId) isolateInvolved(specId);
      else clearIsolation();
    }
  }, [setIdsActiveSpecification, isolationScope, isolateInvolved, clearIsolation]);

  const setIsolationScope = useCallback((scope: 'ids' | 'spec') => {
    setIdsIsolationScope(scope);
    if (scope === 'spec') {
      // Entering per-spec scope isolates the active spec, or clears any stale
      // whole-IDS isolation so the user starts from a clean "pick a spec" slate.
      if (activeSpecificationId) isolateInvolved(activeSpecificationId);
      else clearIsolation();
    } else {
      // Back to whole-IDS scope: drop per-spec isolation and restore colors.
      clearIsolation();
    }
  }, [setIdsIsolationScope, activeSpecificationId, isolateInvolved, clearIsolation]);

  // ============================================================================
  // Utility Getters
  // ============================================================================

  const getFailedEntityIds = useCallback((specId?: string): Array<{ modelId: string; expressId: number }> => {
    if (!report) return [];

    const results: Array<{ modelId: string; expressId: number }> = [];

    for (const specResult of report.specificationResults) {
      if (specId && specResult.specification.id !== specId) continue;

      for (const entityResult of specResult.entityResults) {
        if (!entityResult.passed) {
          results.push({
            modelId: entityResult.modelId,
            expressId: entityResult.expressId,
          });
        }
      }
    }

    return results;
  }, [report]);

  const getPassedEntityIds = useCallback((specId?: string): Array<{ modelId: string; expressId: number }> => {
    if (!report) return [];

    const results: Array<{ modelId: string; expressId: number }> = [];

    for (const specResult of report.specificationResults) {
      if (specId && specResult.specification.id !== specId) continue;

      for (const entityResult of specResult.entityResults) {
        if (entityResult.passed) {
          results.push({
            modelId: entityResult.modelId,
            expressId: entityResult.expressId,
          });
        }
      }
    }

    return results;
  }, [report]);

  const isEntityFailed = useCallback((modelId: string, expressId: number): boolean => {
    return idsFailedEntityIds.has(`${modelId}:${expressId}`);
  }, [idsFailedEntityIds]);

  const isEntityPassed = useCallback((modelId: string, expressId: number): boolean => {
    return idsPassedEntityIds.has(`${modelId}:${expressId}`);
  }, [idsPassedEntityIds]);

  // ============================================================================
  // Export Actions
  // ============================================================================

  const exportReportJSON = useCallback(() => {
    if (!report) {
      console.warn('[IDS] No report to export');
      return;
    }
    downloadReportJSON(report);
  }, [report]);

  const exportReportHTML = useCallback(() => {
    if (!report) {
      console.warn('[IDS] No report to export');
      return;
    }
    downloadReportHTML(report, locale);
  }, [report, locale]);


  // BCF export progress state
  const [bcfExportProgress, setBcfExportProgress] = useState<IDSExportProgress | null>(null);

  // BCF store actions for 'load into panel'
  const setBcfProject = useViewerStore((s) => s.setBcfProject);
  const setBcfPanelVisible = useViewerStore((s) => s.setBcfPanelVisible);
  const bcfAuthor = useViewerStore((s) => s.bcfAuthor);

  const exportReportBCF = useCallback(async (settings: IDSBCFExportSettings) => {
    if (!report) {
      console.warn('[IDS] No report to export');
      return;
    }

    try {
    const {
      topicGrouping,
      includePassingEntities,
      includeCamera,
      includeSnapshots,
      loadIntoBcfPanel,
    } = settings;

    // Phase 1: Collect entity bounds (needed for both camera and snapshots)
    let entityBounds: Map<string, EntityBoundsInput> | undefined;

    if (includeCamera || includeSnapshots) {
      setBcfExportProgress({ phase: 'building', current: 0, total: 1, message: 'Computing entity bounds...' });

      entityBounds = new Map();
      const geomResult = geometryResultRef.current;

      // Collect geometry from all models
      const allMeshData: Array<{ meshes: unknown[]; idOffset: number; modelId: string }> = [];
      for (const [modelId, model] of models.entries()) {
        if (model.geometryResult?.meshes) {
          allMeshData.push({
            meshes: model.geometryResult.meshes,
            idOffset: model.idOffset ?? 0,
            modelId,
          });
        }
      }

      // Also include legacy single-model geometry
      if (geomResult?.meshes && allMeshData.length === 0) {
        allMeshData.push({
          meshes: geomResult.meshes,
          idOffset: 0,
          modelId: 'default',
        });
      }

      // Compute bounds for each entity that appears in the report
      for (const specResult of report.specificationResults) {
        for (const entity of specResult.entityResults) {
          if (entity.passed && !includePassingEntities) continue;
          const boundsKey = `${entity.modelId}:${entity.expressId}`;
          if (entityBounds.has(boundsKey)) continue;

          // Find matching model geometry
          for (const modelData of allMeshData) {
            if (modelData.modelId === entity.modelId || allMeshData.length === 1) {
              const globalExpressId = toViewerGlobalId(entity.modelId, entity.expressId);
              if (globalExpressId == null) break;
              const bounds = getEntityBounds(
                modelData.meshes as Parameters<typeof getEntityBounds>[0],
                globalExpressId,
              );
              if (bounds) {
                entityBounds.set(boundsKey, bounds);
              }
              break;
            }
          }
        }
      }
    }

    // Phase 2: Batch snapshots if requested
    let entitySnapshots: Map<string, string> | undefined;

    if (includeSnapshots) {
      entitySnapshots = new Map();

      // Get renderer for direct rendering control (no selection highlight)
      const renderer = getGlobalRenderer();
      if (!renderer) {
        console.warn('[IDS] No renderer available for snapshot capture');
      } else {
        const camera = renderer.getCamera();

        // Collect all unique entities that need snapshots (Set-based O(1) dedup)
        const seenKeys = new Set<string>();
        const entitiesToSnapshot: Array<{ modelId: string; expressId: number; boundsKey: string }> = [];
        for (const specResult of report.specificationResults) {
          for (const entity of specResult.entityResults) {
            if (entity.passed && !includePassingEntities) continue;
            const boundsKey = `${entity.modelId}:${entity.expressId}`;
            if (!seenKeys.has(boundsKey)) {
              seenKeys.add(boundsKey);
              entitiesToSnapshot.push({
                modelId: entity.modelId,
                expressId: entity.expressId,
                boundsKey,
              });
            }
          }
        }

        const total = entitiesToSnapshot.length;

        // Save current viewer state to restore after snapshot batch
        const storeState = useViewerStore.getState();
        const savedSelection = storeState.selectedEntityId;
        const savedIsolation = storeState.isolatedEntities;
        const savedHidden = storeState.hiddenEntities;

        for (let i = 0; i < total; i++) {
          const entity = entitiesToSnapshot[i];
          setBcfExportProgress({
            phase: 'snapshots',
            current: i + 1,
            total,
            message: `Capturing snapshot ${i + 1}/${total}...`,
          });

          // Get the entity's bounds for framing
          const bounds = entityBounds?.get(entity.boundsKey);
          if (!bounds) continue;

          // Find the global expressId for isolation (direct Map lookup)
          const globalExpressId = toViewerGlobalId(entity.modelId, entity.expressId);
          if (globalExpressId == null) continue;

          // Frame the entity bounds directly via camera (properly centers the object)
          // duration=1 (not 0) because the animator skips updates when duration===0,
          // causing the camera to never move. 1ms is effectively instant.
          await camera.frameBounds(bounds.min, bounds.max, 1);

          // Render with: entity isolated, NO selection highlight (no cyan), IDS colors intact
          const isolationSet = new Set([globalExpressId]);
          renderer.render({
            isolatedIds: isolationSet,
            selectedId: null,           // No cyan selection highlight
            clearColor: SNAPSHOT_CLEAR_COLOR,
          });

          // Wait for GPU commands to complete
          const device = renderer.getGPUDevice();
          if (device) {
            await device.queue.onSubmittedWorkDone();
          }

          // Wait for the browser compositor to present the frame to the canvas.
          // Without this, toDataURL() reads a stale canvas — only the last snapshot
          // would show the entity because previous frames haven't been composited yet.
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

          // Capture the now-presented frame
          const dataUrl = await renderer.captureScreenshot();
          if (dataUrl) {
            entitySnapshots.set(entity.boundsKey, dataUrl);
          }
        }

        // Restore viewer state — set store back to saved state directly
        useViewerStore.setState({
          selectedEntityId: savedSelection,
          isolatedEntities: savedIsolation,
          hiddenEntities: savedHidden,
        });

        // Re-render with restored state (original clearColor restored by omitting it)
        renderer.render({
          hiddenIds: savedHidden,
          isolatedIds: savedIsolation,
          selectedId: savedSelection,
        });
      }
    }

    // Phase 3: Build BCF project
    setBcfExportProgress({ phase: 'writing', current: 0, total: 1, message: 'Building BCF project...' });

    const exportOptions: IDSBCFExportOptions = {
      author: bcfAuthor || report.document.info.author || 'ids-validator@ifc-lite',
      projectName: `IDS Report - ${report.document.info.title}`,
      topicGrouping,
      includePassingEntities,
      entityBounds,
      entitySnapshots,
    };

    const bcfProject = createBCFFromIDSReport(
      {
        title: report.document.info.title,
        description: report.document.info.description,
        specificationResults: report.specificationResults,
      },
      exportOptions,
    );

    // Phase 4: Write BCF and download
    setBcfExportProgress({ phase: 'writing', current: 1, total: 2, message: 'Writing BCF file...' });

    const blob = await writeBCF(bcfProject);
    downloadBlob(blob, `ids-report-${new Date().toISOString().split('T')[0]}.bcfzip`);

    // Phase 5: Load into BCF panel if requested
    if (loadIntoBcfPanel) {
      setBcfProject(bcfProject);
      setBcfPanelVisible(true);
    }

    setBcfExportProgress({ phase: 'done', current: 1, total: 1, message: 'Export complete!' });

    // Clear progress after a delay
    setTimeout(() => setBcfExportProgress(null), 2000);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'BCF export failed';
      setIdsError(message);
      console.error('[IDS] BCF export error:', err);
      setBcfExportProgress(null);
    }
  }, [
    report,
    models,
    bcfAuthor,
    setIdsError,
    setBcfProject,
    setBcfPanelVisible,
  ]);

  // ============================================================================
  // Return
  // ============================================================================

  return {
    // State
    document,
    auditReport,
    auditing,
    report,
    loading,
    progress,
    error,
    locale,
    panelVisible,
    activeSpecificationId,
    activeEntityId,
    filterMode,
    isolationScope,
    isolateMode,
    isolationActive: isolatedEntities != null,
    displayOptions,

    // Document actions
    loadIDS,
    loadIDSFile,
    clearIDS,

    // Validation actions
    runValidation,
    clearValidation,

    // Selection actions
    setActiveSpecification,
    selectEntity,
    clearEntitySelection,

    // UI actions
    setPanelVisible,
    togglePanel,
    setLocale,
    setFilterMode: setFilterModeAction,
    setIsolationScope,
    setDisplayOptions: setDisplayOptionsAction,

    // Color actions
    applyColors,
    clearColors,

    // Isolation actions
    isolateFailed,
    isolatePassed,
    isolateInvolved,
    clearIsolation,

    // Utility getters
    getFailedEntityIds,
    getPassedEntityIds,
    isEntityFailed,
    isEntityPassed,

    // Export actions
    exportReportJSON,
    exportReportHTML,
    exportReportBCF,
    bcfExportProgress,
  };
}
