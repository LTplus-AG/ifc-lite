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
import {
  endIdsRowFocusPresentation,
  type IDSRowFocusPresentation,
  type IDSFocusVisibilityOwnership,
} from '../../lib/ids/visibility-ownership.js';

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

/**
 * Scope for the isolate/color controls.
 * - 'ids': act on the whole validation report (every specification combined)
 * - 'spec': act on the currently active specification only
 */
export type IDSIsolationScope = 'ids' | 'spec';

/**
 * Which IDS isolate action is currently applied, so the panel can show the
 * active button as pressed and toggle it off on a second click. `null` when
 * IDS is not isolating.
 */
export type IDSIsolateMode = 'failed' | 'passed' | 'involved' | null;

/**
 * How the rest of the model is shown when a single IDS result ROW is activated
 * (#2867) — the same three modes, the same names and the same persistence as
 * the clash panel's `ClashFocusMode`, because it is the same action:
 *
 * - 'highlight': keep the whole model visible;
 * - 'isolate':   hide everything except the activated element;
 * - 'ghost':     fade the rest to translucent context (X-Ray).
 *
 * A workspace preference: it survives a report clear and a panel switch, like
 * `clashFocusMode`, so the user picks how they review once rather than per
 * row.
 */
export type IDSFocusMode = 'highlight' | 'isolate' | 'ghost';

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
  /**
   * Whether the isolate/color controls act on the whole report ('ids',
   * default) or on the active specification only ('spec'). In 'spec' mode,
   * selecting a specification isolates its involved elements (passed green,
   * failed red) so they can be reviewed in context — per issue #1236.
   */
  idsIsolationScope: IDSIsolationScope;
  /** Which isolate action is currently applied (drives toggle + active state) */
  idsIsolateMode: IDSIsolateMode;
  /**
   * How activating a single result row presents the rest of the model
   * (#2867). Persistent user preference — see {@link IDSFocusMode}.
   */
  idsFocusMode: IDSFocusMode;
  /**
   * The CLAIM the row focus holds on the shared isolation/ghost channels —
   * what it installed and where — so a teardown can release exactly that and
   * nothing else. `null` means the row focus owns neither channel. See
   * `lib/ids/visibility-ownership.ts`.
   */
  idsFocusVisibilityOwned: IDSFocusVisibilityOwnership;
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
  setIdsIsolationScope: (scope: IDSIsolationScope) => void;
  setIdsIsolateMode: (mode: IDSIsolateMode) => void;
  setIdsFocusMode: (mode: IDSFocusMode) => void;
  setIdsFocusVisibilityOwned: (owned: IDSFocusVisibilityOwnership) => void;

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

/**
 * End the per-row focus presentation (#2867) before a state change discards
 * the report the focused row belonged to.
 *
 * ORDER is load-bearing, and it is the same order `endClashScenePresentation`
 * documents: RELEASE the shared channel first, THEN let the caller's `set()`
 * null the record. Nulling first leaves the release reading `null`, finding
 * nothing to release, and leaving a row isolation standing over a report that
 * no longer exists — `isEntityVisible` false for everything, with nothing on
 * screen to explain it.
 *
 * The release is ownership-scoped, so a clash focus, a spaces X-ray or IDS's
 * own set-level isolation occupying the channel instead is left alone.
 */
function endIdsRowFocus(get: () => IDSSlice): void {
  endIdsRowFocusPresentation(get() as unknown as IDSRowFocusPresentation);
}

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
  idsIsolationScope: 'ids',
  idsIsolateMode: null,
  // Ghost by default, exactly as `clashFocusMode` is: the reported problem is
  // that the activated element cannot be FOUND, and ghosting is the only mode
  // that both removes the surrounding clutter and keeps enough of the building
  // on screen to tell where in it you are landed. `isolate` answers the first
  // half and loses the context; `highlight` answers neither on its own.
  idsFocusMode: 'ghost',
  idsFocusVisibilityOwned: null,
  idsFailedEntityIds: new Set(),
  idsPassedEntityIds: new Set(),

  // Document actions
  setIdsDocument: (idsDocument) => {
    // A new document invalidates the report the focused row came from, so the
    // row focus's claim on the shared channels ends here too.
    endIdsRowFocus(get);
    set({
      idsDocument,
      // Loading a new document invalidates any previous audit/validation
      // results — they were tied to a specific document instance. That
      // includes `idsIsolateMode`: it drives the isolate-button "pressed"
      // state and the 3D isolation built from the now-discarded report, so
      // it must be cleared here exactly like `clearIdsValidationReport`
      // clears it — otherwise the panel keeps showing an isolate mode as
      // active for a report that no longer exists.
      idsAuditReport: null,
      idsValidationReport: null,
      idsActiveSpecificationId: null,
      idsActiveEntityId: null,
      idsError: null,
      idsFailedEntityIds: new Set(),
      idsPassedEntityIds: new Set(),
      idsIsolationScope: 'ids',
      idsIsolateMode: null,
      idsFocusVisibilityOwned: null,
    });
  },

  clearIdsDocument: () => {
    // `useIDS.clearIDS` bumps `validationEpochRef` right before calling this,
    // so a `runValidation()` still in flight sees `stillWantedValidation` go
    // false and skips its OWN `finally` reset of `idsLoading`/`idsProgress`
    // (by design — that call is no longer the current one and must not flip
    // busy state out from under whatever superseded it). Nothing else then
    // ever turns them off, so the clear itself has to (PR #2837 review):
    // without this, a clear that lands mid-run leaves the UI showing a
    // validation spinner that never resolves.
    // `endIdsRowFocus` runs first for the same reason it does in
    // `setIdsDocument`: the release must precede the record being nulled.
    endIdsRowFocus(get);
    set({
      idsDocument: null,
      idsAuditReport: null,
      idsValidationReport: null,
      idsActiveSpecificationId: null,
      idsActiveEntityId: null,
      idsError: null,
      idsFailedEntityIds: new Set(),
      idsPassedEntityIds: new Set(),
      idsLoading: false,
      idsProgress: null,
      idsIsolationScope: 'ids',
      idsIsolateMode: null,
      idsFocusVisibilityOwned: null,
    });
  },

  // Audit actions
  setIdsAuditReport: (idsAuditReport) => set({ idsAuditReport }),
  setIdsAuditing: (idsAuditing) => set({ idsAuditing }),

  // Validation actions
  setIdsValidationReport: (report) => {
    const { failed, passed } = buildEntityIdSets(report);
    // A landing report replaces the one the focused row belonged to — its
    // express ids may denote different entities now. Release before the
    // record is nulled below.
    endIdsRowFocus(get);
    set({
      idsValidationReport: report,
      idsFailedEntityIds: failed,
      idsPassedEntityIds: passed,
      idsIsolateMode: null,
      idsFocusVisibilityOwned: null,
      idsError: null,
      idsProgress: null,
    });
  },

  clearIdsValidationReport: () => {
    // Same reasoning as `clearIdsDocument` above: `useIDS.clearValidation`
    // bumps the epoch first, which makes a still-in-flight `runValidation()`
    // skip its own `idsLoading`/`idsProgress` reset on purpose — this is the
    // only remaining writer for those fields once that happens (PR #2837
    // review).
    // And, as in `clearIdsDocument`, the row focus is released BEFORE its
    // record is nulled — otherwise the isolation outlives the report.
    endIdsRowFocus(get);
    set({
      idsValidationReport: null,
      idsActiveSpecificationId: null,
      idsActiveEntityId: null,
      idsIsolationScope: 'ids',
      idsIsolateMode: null,
      idsFocusVisibilityOwned: null,
      idsFailedEntityIds: new Set(),
      idsPassedEntityIds: new Set(),
      idsLoading: false,
      idsProgress: null,
    });
  },

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

  // Setting an error ends the run; but CLEARING the error (idsError =
  // null, e.g. at the start of a validation run) must NOT flip loading
  // off — doing so kept the progress UI, which is gated on `loading`,
  // hidden for the entire run even though progress was streaming in.
  setIdsError: (idsError) =>
    set(idsError !== null ? { idsError, idsLoading: false } : { idsError }),

  setIdsLocale: (idsLocale) => set({ idsLocale }),

  setIdsDisplayOptions: (options) =>
    set((state) => ({
      idsDisplayOptions: { ...state.idsDisplayOptions, ...options },
    })),

  setIdsFilterMode: (idsFilterMode) => set({ idsFilterMode }),

  setIdsIsolationScope: (idsIsolationScope) => set({ idsIsolationScope }),

  setIdsIsolateMode: (idsIsolateMode) => set({ idsIsolateMode }),

  setIdsFocusMode: (idsFocusMode) => set({ idsFocusMode }),

  setIdsFocusVisibilityOwned: (idsFocusVisibilityOwned) => set({ idsFocusVisibilityOwned }),

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
