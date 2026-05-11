/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS (Information Delivery Specification) state slice
 *
 * Manages IDS validation state, results, and viewer integration.
 */

import type { StateCreator } from 'zustand';
import type {
  IDSAuditReport,
  IDSDocument,
  IDSValidationReport,
  IDSSpecificationResult,
  IDSEntityResult,
  SupportedLocale,
  ValidationProgress,
} from '@ifc-lite/ids';

// ============================================================================
// Types
// ============================================================================

/** Display options for IDS visualization */
export interface IDSDisplayOptions {
  /** Highlight failed entities in 3D view */
  highlightFailed: boolean;
  /** Highlight passed entities in 3D view */
  highlightPassed: boolean;
  /** Color for failed entities [R, G, B, A] */
  failedColor: [number, number, number, number];
  /** Color for passed entities [R, G, B, A] */
  passedColor: [number, number, number, number];
}

/** IDS filter mode */
export type IDSFilterMode = 'all' | 'failed' | 'passed';

export interface IDSSliceState {
  /** Loaded IDS document */
  idsDocument: IDSDocument | null;
  /**
   * Audit report for the loaded IDS document itself — flags authoring
   * issues (missing attributes, invalid IFC entity references, regex
   * errors, etc.). Distinct from `idsValidationReport`, which describes
   * how an IFC model conforms to the IDS.
   */
  idsAuditReport: IDSAuditReport | null;
  /** Whether the audit pipeline is currently running. */
  idsAuditing: boolean;
  /** Validation report after running validation */
  idsValidationReport: IDSValidationReport | null;
  /** Currently active specification (for filtering results) */
  idsActiveSpecificationId: string | null;
  /** Currently selected entity in results */
  idsActiveEntityId: { modelId: string; expressId: number } | null;
  /** IDS panel visibility */
  idsPanelVisible: boolean;
  /** Loading state */
  idsLoading: boolean;
  /** Validation progress */
  idsProgress: ValidationProgress | null;
  /** Error message */
  idsError: string | null;
  /** Current locale for translations */
  idsLocale: SupportedLocale;
  /** Display options */
  idsDisplayOptions: IDSDisplayOptions;
  /** Filter mode (show all, failed only, passed only) */
  idsFilterMode: IDSFilterMode;
  /** Cached set of failed entity IDs for efficient lookup */
  idsFailedEntityIds: Set<string>; // "modelId:expressId" format
  /** Cached set of passed entity IDs */
  idsPassedEntityIds: Set<string>;
}

export interface IDSSlice extends IDSSliceState {
  // Document actions
  setIdsDocument: (document: IDSDocument | null) => void;
  clearIdsDocument: () => void;

  // Audit actions
  setIdsAuditReport: (report: IDSAuditReport | null) => void;
  setIdsAuditing: (auditing: boolean) => void;

  // Validation actions
  setIdsValidationReport: (report: IDSValidationReport | null) => void;
  clearIdsValidationReport: () => void;
  setIdsProgress: (progress: ValidationProgress | null) => void;

  // Selection actions
  setIdsActiveSpecification: (specId: string | null) => void;
  setIdsActiveEntity: (ref: { modelId: string; expressId: number } | null) => void;

  // UI actions
  setIdsPanelVisible: (visible: boolean) => void;
  toggleIdsPanel: () => void;
  setIdsLoading: (loading: boolean) => void;
  setIdsError: (error: string | null) => void;
  setIdsLocale: (locale: SupportedLocale) => void;
  setIdsDisplayOptions: (options: Partial<IDSDisplayOptions>) => void;
  setIdsFilterMode: (mode: IDSFilterMode) => void;

  // Utility getters
  getActiveSpecificationResult: () => IDSSpecificationResult | null;
  getFailedEntitiesForSpec: (specId: string) => IDSEntityResult[];
  getPassedEntitiesForSpec: (specId: string) => IDSEntityResult[];
  getEntityResultById: (modelId: string, expressId: number) => IDSEntityResult | null;
  isEntityFailed: (modelId: string, expressId: number) => boolean;
  isEntityPassed: (modelId: string, expressId: number) => boolean;
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_DISPLAY_OPTIONS: IDSDisplayOptions = {
  highlightFailed: true,
  highlightPassed: false,
  failedColor: [0.9, 0.2, 0.2, 1.0], // Red
  passedColor: [0.2, 0.8, 0.2, 1.0], // Green
};

const getDefaultLocale = (): SupportedLocale => {
  // Try to get from browser language
  if (typeof navigator !== 'undefined') {
    const lang = navigator.language.split('-')[0];
    if (lang === 'de' || lang === 'fr') {
      return lang as SupportedLocale;
    }
  }
  return 'en';
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build cached entity ID sets from validation report
 */
function buildEntityIdSets(
  report: IDSValidationReport | null
): { failed: Set<string>; passed: Set<string> } {
  const failed = new Set<string>();
  const passed = new Set<string>();

  if (!report) {
    return { failed, passed };
  }

  for (const specResult of report.specificationResults) {
    for (const entityResult of specResult.entityResults) {
      const key = `${entityResult.modelId}:${entityResult.expressId}`;
      if (entityResult.passed) {
        passed.add(key);
      } else {
        failed.add(key);
      }
    }
  }

  return { failed, passed };
}

// ============================================================================
// Slice Creator
// ============================================================================

export const createIdsSlice: StateCreator<IDSSlice, [], [], IDSSlice> = (set, get) => ({
  // Initial state
  idsDocument: null,
  idsAuditReport: null,
  idsAuditing: false,
  idsValidationReport: null,
  idsActiveSpecificationId: null,
  idsActiveEntityId: null,
  idsPanelVisible: false,
  idsLoading: false,
  idsProgress: null,
  idsError: null,
  idsLocale: getDefaultLocale(),
  idsDisplayOptions: DEFAULT_DISPLAY_OPTIONS,
  idsFilterMode: 'all',
  idsFailedEntityIds: new Set(),
  idsPassedEntityIds: new Set(),

  // Document actions
  setIdsDocument: (idsDocument) =>
    set({
      idsDocument,
      // Loading a new document invalidates any previous audit/validation
      // results — they were tied to a specific document instance.
      idsAuditReport: null,
      idsValidationReport: null,
      idsActiveSpecificationId: null,
      idsActiveEntityId: null,
      idsError: null,
      idsFailedEntityIds: new Set(),
      idsPassedEntityIds: new Set(),
    }),

  clearIdsDocument: () =>
    set({
      idsDocument: null,
      idsAuditReport: null,
      idsValidationReport: null,
      idsActiveSpecificationId: null,
      idsActiveEntityId: null,
      idsError: null,
      idsFailedEntityIds: new Set(),
      idsPassedEntityIds: new Set(),
    }),

  // Audit actions
  setIdsAuditReport: (idsAuditReport) => set({ idsAuditReport }),
  setIdsAuditing: (idsAuditing) => set({ idsAuditing }),

  // Validation actions
  setIdsValidationReport: (report) => {
    const { failed, passed } = buildEntityIdSets(report);
    set({
      idsValidationReport: report,
      idsFailedEntityIds: failed,
      idsPassedEntityIds: passed,
      idsError: null,
      idsProgress: null,
    });
  },

  clearIdsValidationReport: () =>
    set({
      idsValidationReport: null,
      idsActiveSpecificationId: null,
      idsActiveEntityId: null,
      idsFailedEntityIds: new Set(),
      idsPassedEntityIds: new Set(),
    }),

  setIdsProgress: (idsProgress) => set({ idsProgress }),

  // Selection actions
  setIdsActiveSpecification: (idsActiveSpecificationId) =>
    set({
      idsActiveSpecificationId,
      idsActiveEntityId: null,
    }),

  setIdsActiveEntity: (idsActiveEntityId) => set({ idsActiveEntityId }),

  // UI actions
  setIdsPanelVisible: (idsPanelVisible) => set({ idsPanelVisible }),

  toggleIdsPanel: () => set((state) => ({ idsPanelVisible: !state.idsPanelVisible })),

  setIdsLoading: (idsLoading) => set({ idsLoading }),

  setIdsError: (idsError) => set({ idsError, idsLoading: false }),

  setIdsLocale: (idsLocale) => set({ idsLocale }),

  setIdsDisplayOptions: (options) =>
    set((state) => ({
      idsDisplayOptions: { ...state.idsDisplayOptions, ...options },
    })),

  setIdsFilterMode: (idsFilterMode) => set({ idsFilterMode }),

  // Utility getters
  getActiveSpecificationResult: () => {
    const state = get();
    if (!state.idsValidationReport || !state.idsActiveSpecificationId) {
      return null;
    }
    return (
      state.idsValidationReport.specificationResults.find(
        (r) => r.specification.id === state.idsActiveSpecificationId
      ) || null
    );
  },

  getFailedEntitiesForSpec: (specId) => {
    const state = get();
    if (!state.idsValidationReport) return [];

    const specResult = state.idsValidationReport.specificationResults.find(
      (r) => r.specification.id === specId
    );
    if (!specResult) return [];

    return specResult.entityResults.filter((e) => !e.passed);
  },

  getPassedEntitiesForSpec: (specId) => {
    const state = get();
    if (!state.idsValidationReport) return [];

    const specResult = state.idsValidationReport.specificationResults.find(
      (r) => r.specification.id === specId
    );
    if (!specResult) return [];

    return specResult.entityResults.filter((e) => e.passed);
  },

  getEntityResultById: (modelId, expressId) => {
    const state = get();
    if (!state.idsValidationReport) return null;

    for (const specResult of state.idsValidationReport.specificationResults) {
      for (const entityResult of specResult.entityResults) {
        if (
          entityResult.modelId === modelId &&
          entityResult.expressId === expressId
        ) {
          return entityResult;
        }
      }
    }
    return null;
  },

  isEntityFailed: (modelId, expressId) => {
    const state = get();
    return state.idsFailedEntityIds.has(`${modelId}:${expressId}`);
  },

  isEntityPassed: (modelId, expressId) => {
    const state = get();
    return state.idsPassedEntityIds.has(`${modelId}:${expressId}`);
  },
});
