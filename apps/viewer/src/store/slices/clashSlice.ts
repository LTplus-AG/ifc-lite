/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash detection panel state (Phase 1). Detection itself lives in
 * `@ifc-lite/clash`; this slice holds the panel's UI state, the last result,
 * and the user's persisted detection settings + rule presets (see
 * `lib/clash/persistence.ts`, modeled on the lens slice). Orchestration
 * (gathering elements, running the engine, applying colors / selection /
 * camera, BCF export) lives in the `useClash` hook.
 */

import type { StateCreator } from 'zustand';
import type {
  ClashResult,
  ClashGroup,
  ClashMode,
  ClashProgress,
  ClashReview,
  ClashReviewStatus,
  ClashSortBy,
} from '@ifc-lite/clash';
import { CLASH_REVIEW_STATUSES, DEFAULT_CLASH_REVIEW_STATUS, groupClashes } from '@ifc-lite/clash';
import {
  applyClashExclusions,
  exclusionRuleKey,
  type ClashExclusionRule,
} from '@/lib/clash/exclusions';

/** How the rest of the model is shown when a clash is focused (#1275). Lives
 *  here (not in `useClash`) so the panel's view choice persists across panel
 *  switches. (#1464) */
export type ClashFocusMode = 'highlight' | 'isolate' | 'ghost';
import {
  buildInitialPresets,
  defaultPresets,
  loadExclusions,
  loadReviews,
  loadSettings,
  saveExclusions,
  savePresets,
  saveReviews,
  saveSettings,
  validatePresetName,
  validateSelector,
  CLASH_BOUNDS,
  clampToBounds,
  DEFAULT_CLASH_SETTINGS,
  type ClashPreset,
  type ClashGlobalSettings,
  type ClashSettingsGroupBy,
  type SaveResult,
} from '@/lib/clash/persistence';
import { reportClashSettingsSaveFailure } from '@/lib/clash/settings-save-notice';

export type ClashGroupBy = ClashSettingsGroupBy;
export type { ClashPreset, ClashGlobalSettings, SaveResult };
export type { ClashExclusionRule };

/** Fields a user supplies when adding a custom rule (id/flags filled in here). */
export type NewClashPreset = {
  name: string;
  description?: string;
  severity: ClashPreset['severity'];
  selectorA: string;
  selectorB: string;
};

export interface ClashSlice {
  clashPanelVisible: boolean;
  /**
   * The last run's output with the user's ENABLED exclusions removed — what the
   * panel, the grouping and the BCF export all read.
   */
  clashResult: ClashResult | null;
  /**
   * The same run, unfiltered. Kept so toggling or removing an exclusion can
   * re-derive `clashResult` (and `clashGroups`) instead of re-running detection,
   * which is what makes an exclusion genuinely undoable.
   */
  clashRawResult: ClashResult | null;
  clashGroups: ClashGroup[] | null;
  /**
   * Provenance of `clashGroups` — which of the two writers produced it.
   * `'derived'`: computed from `clashRawResult` by `deriveGroups` (spatial
   * clusters, via `setClashResult`, `setClashClusterEpsilon`, or an exclusion
   * edit). `'manual'`: an explicit override (`setClashGroups`, the duplicate
   * scan's coincident-SET grouping). `null` iff `clashGroups` is `null`.
   *
   * This is the gate that keeps the two writers from fighting over the same
   * field: `deriveGroups` refuses to replace a `'manual'` grouping unless it
   * is also given a genuinely new raw result (a fresh run always wins — see
   * `deriveGroups`'s `newRun` parameter). Without this, a later
   * `setClashClusterEpsilon` or exclusion edit — neither of which runs a new
   * scan — would silently re-derive spatial clusters over the SAME duplicate
   * pairs a manual grouping already covers, mislabeling instead of leaving it
   * alone (found in review of #2535, PR comment 5305847983).
   */
  clashGroupsKind: 'derived' | 'manual' | null;
  clashRunning: boolean;
  clashError: string | null;
  /**
   * Monotonic count of COMPLETED detection runs (all-clashes, matrix, preset,
   * duplicate scan). Bumped by `useClash` right after each successful
   * `setClashResult` - never on error paths and never reset - so a consumer
   * needing "a run completed since X" (e.g. the clash tour's run gate) can
   * baseline-compare a number instead of reference-diffing `clashResult`.
   */
  clashRunSeq: number;
  /** Live detection progress for the running rule (null when idle). */
  clashProgress: ClashProgress | null;
  /** Detection settings (persisted). */
  clashMode: ClashMode;
  clashTolerance: number;
  clashClearance: number;
  /** Duplicate-scan position tolerance (m) — feeds `findDuplicates`; distinct
   *  from `clashTolerance`, the clash engine's touching band (#2530). */
  clashDuplicateTolerance: number;
  clashClusterEpsilon: number;
  clashReportTouch: boolean;
  /** How the result list is organized (persisted). */
  clashGroupBy: ClashGroupBy;
  /** Result-list sort key - view state, kept in the store so it survives a
   *  panel switch instead of resetting to default each time. (#1464) */
  clashSortBy: ClashSortBy;
  /** "Hide touching" result filter - view state, same persistence. (#1464) */
  clashHideTouching: boolean;
  /** On-select focus presentation (highlight / isolate / ghost). (#1464) */
  clashFocusMode: ClashFocusMode;
  /** Built-in + custom rule presets (persisted). */
  clashPresets: ClashPreset[];
  /**
   * Per-clash REVIEW state (status + optional comment), keyed by the durable
   * `clashReviewKey` from `@ifc-lite/clash` so it survives reloads, re-runs and
   * revisions. Persisted separately from the run result (workspace state, like
   * presets); never wiped by `clearClash`. (#1468)
   */
  clashReviews: Map<string, ClashReview>;
  /** Which review statuses are shown in the panel list (view filter). (#1468) */
  clashStatusFilter: Set<ClashReviewStatus>;
  /**
   * The user's own exclusion rules — "this overlap is by design" (persisted).
   * A whole IFC type pair or one specific element pair; see
   * `lib/clash/exclusions.ts`. Distinct from a REVIEW, which annotates a clash
   * without hiding it, and from the engine's IFC-derived exclusions, which the
   * user never sees.
   */
  clashExclusions: ClashExclusionRule[];
  /** Rule id → how many clashes of `clashRawResult` that rule covers (disabled ones too). */
  clashExclusionCounts: Map<string, number>;
  /** How many clashes the enabled rules are currently hiding. */
  clashSuppressedCount: number;
  /** Currently focused clash id (for highlight in the list). */
  clashSelectedId: string | null;
  /**
   * Per-element highlight tint for the focused clash pair — `Map<globalId, RGBA>`
   * (element A one vibrant colour, element B another). Fed to the renderer so the
   * selection glow paints A and B distinctly instead of the single selection
   * blue. `null` when no clash is focused. (#1277/#1339)
   */
  clashHighlightColors: Map<number, [number, number, number, number]> | null;
  /**
   * World-space AABB of the focused clash's overlap region (`Clash.bounds`),
   * drawn as a distinct-colour wireframe box so the overlap reads as a third
   * colour next to the two glowing elements. `null` when no clash is focused.
   * (#1277)
   */
  clashOverlapBox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * The focused clash's CONTACT geometry as a flat world-frame line-list (the
   * real shared-face polygon outlines / intersection lines). Preferred over the
   * AABB `clashOverlapBox` when present. `null` when no clash is focused or the
   * contact could not be computed (then the box is used). (#1402)
   */
  clashContactLines: { vertices: number[]; color: [number, number, number, number] } | null;
  /**
   * Whether the focused clash's region box is drawn in the 3D view. On by
   * default (#1402): with the tight contact bounds (#1362 Bug B) the box marks
   * the actual penetration region instead of the old whole-element AABB that
   * obscured everything. It draws on the always-visible overlay so it shows
   * through the (often isolated) clashing solids; toggle it off in clash settings.
   */
  showClashRegionBox: boolean;

  setClashPanelVisible: (visible: boolean) => void;
  toggleClashPanel: () => void;
  setClashResult: (result: ClashResult | null) => void;
  /**
   * Overrides the derived spatial-cluster grouping with an explicit one, and
   * marks it `'manual'` in `clashGroupsKind`. Used only by the duplicate scan
   * (#2530): `setClashResult` just derived `clashGroups` as spatial clusters
   * over the AABB-overlap pairs, which isn't the grouping duplicate results
   * should show — the scan replaces it with coincident SETS right after.
   *
   * CORRECTION (review of #2535, PR comment 5305847983): a previous version of
   * this doc claimed a later `setClashClusterEpsilon` or exclusion change
   * "still re-derives spatial clusters from `clashRawResult`... (acceptable:
   * neither applies to a duplicate-scan result)". That was false — the
   * duplicate scan's `setClashResult(res)` call (before this one) makes
   * `clashRawResult` the duplicate scan's OWN pairwise result, so both DO
   * apply to it. The override now survives them because `deriveGroups`
   * refuses to replace a `'manual'` grouping without a genuinely new raw
   * result: it lasts exactly until the next `setClashResult` (a real run),
   * not merely until the next re-derivation from the same raw result.
   */
  setClashGroups: (groups: ClashGroup[] | null) => void;
  bumpClashRunSeq: () => void;
  setClashRunning: (running: boolean) => void;
  setClashError: (error: string | null) => void;
  setClashProgress: (progress: ClashProgress | null) => void;
  setClashMode: (mode: ClashMode) => void;
  setClashTolerance: (tolerance: number) => void;
  setClashClearance: (clearance: number) => void;
  setClashDuplicateTolerance: (tolerance: number) => void;
  setClashClusterEpsilon: (epsilon: number) => void;
  setClashReportTouch: (reportTouch: boolean) => void;
  setClashGroupBy: (groupBy: ClashGroupBy) => void;
  setClashSortBy: (sortBy: ClashSortBy) => void;
  setClashHideTouching: (hide: boolean) => void;
  setClashFocusMode: (mode: ClashFocusMode) => void;
  resetClashSettings: () => void;
  setClashSelectedId: (id: string | null) => void;
  setClashHighlightColors: (colors: Map<number, [number, number, number, number]> | null) => void;
  setClashOverlapBox: (box: { min: [number, number, number]; max: [number, number, number] } | null) => void;
  setClashContactLines: (lines: { vertices: number[]; color: [number, number, number, number] } | null) => void;
  setShowClashRegionBox: (show: boolean) => void;
  // Preset CRUD (persisted). Every one of these returns a SaveResult and only
  // commits to the store when the write actually landed, so the panel can never
  // show a rule change as applied that a refused write (quota, or storage
  // blocked entirely) would undo on the next reload. Callers surface the
  // failure via `result.message`.
  createClashPreset: (input: NewClashPreset) => SaveResult;
  updateClashPreset: (id: string, patch: Partial<Omit<ClashPreset, 'id' | 'builtin'>>) => SaveResult;
  /** No-op (and `{ ok: true }`) for a built-in or unknown id: nothing to persist. */
  deleteClashPreset: (id: string) => SaveResult;
  setClashPresetEnabled: (id: string, enabled: boolean) => SaveResult;
  resetClashPresets: () => SaveResult;
  importClashPresets: (presets: ClashPreset[]) => SaveResult;
  /** Merge a patch into a clash's review (status and/or comment) and persist.
   *  Resetting to the default (open, empty comment) drops the entry. (#1468) */
  setClashReview: (key: string, patch: { status?: ClashReviewStatus; comment?: string }) => SaveResult;
  /** Toggle whether a review status is shown in the list. */
  toggleClashStatusFilter: (status: ClashReviewStatus) => void;
  // Exclusion CRUD (persisted). Gated on the write landing, like preset CRUD:
  // an exclusion the panel shows as saved but storage refused would silently
  // come back on the next reload.
  /** Add a rule. A duplicate (same kind + same pair, either order) is a no-op. */
  addClashExclusion: (rule: ClashExclusionRule) => SaveResult;
  removeClashExclusion: (id: string) => SaveResult;
  setClashExclusionEnabled: (id: string, enabled: boolean) => SaveResult;
  clearClashExclusions: () => SaveResult;
  /**
   * Replace the entire clash config (presets + detection settings) and persist.
   * Used when activating a flavor/profile so each one carries its own rule-set.
   */
  applyClashFlavorConfig: (config: { presets: ClashPreset[]; settings: ClashGlobalSettings }) => void;
  clearClash: () => void;
}

/** Build the persisted settings blob from current slice state. */
function snapshotSettings(s: ClashSlice): ClashGlobalSettings {
  return {
    mode: s.clashMode,
    tolerance: s.clashTolerance,
    clearance: s.clashClearance,
    duplicateTolerance: s.clashDuplicateTolerance,
    clusterEpsilon: s.clashClusterEpsilon,
    reportTouch: s.clashReportTouch,
    groupBy: s.clashGroupBy,
  };
}

/**
 * Everything derived from (raw result × exclusion rules): the filtered result,
 * its clusters, each rule's reach and the suppressed total — PLUS the single
 * gate that keeps this derivation from clobbering a `'manual'` grouping it did
 * not produce (`setClashGroups`, the duplicate scan's coincident-SET view).
 *
 * `clashResult` / `clashExclusionCounts` / `clashSuppressedCount` are always
 * recomputed from `raw` — exclusions must keep filtering a duplicate scan's
 * result too. Only the `clashGroups` field is gated: this is `@ifc-lite/clash`
 * grouping module (spatial clusters, no per-run identity), not a duplicate-
 * scan detector, and it must never overwrite a grouping some OTHER writer
 * produced unless it also owns a genuinely new raw result to derive from.
 *
 * `newRun` distinguishes the two situations that call this:
 * - `true` (only from `setClashResult`): `raw` just changed — a real
 *   detection/scan completed. Any prior manual override was for the
 *   PREVIOUS run's clashes, which no longer exist, so it is superseded
 *   unconditionally.
 * - `false` (`setClashClusterEpsilon`, `commitExclusions`): `raw` is
 *   UNCHANGED — nothing was re-run, only a setting changed. This derivation
 *   did not produce the current `'manual'` grouping (if any) and has no basis
 *   to replace it, so it leaves `clashGroups`/`clashGroupsKind` alone.
 *
 * This is the ONLY place `clashGroups` is computed from `clashRawResult` — a
 * future re-derivation site should route through here (not call
 * `groupClashes` directly) to inherit the guard for free.
 */
function deriveGroups(
  state: Pick<ClashSlice, 'clashGroups' | 'clashGroupsKind'>,
  raw: ClashResult | null,
  rules: readonly ClashExclusionRule[],
  clusterEpsilon: number,
  newRun: boolean,
): Pick<ClashSlice, 'clashResult' | 'clashGroups' | 'clashGroupsKind' | 'clashExclusionCounts' | 'clashSuppressedCount'> {
  const { result, counts, suppressed } = applyClashExclusions(raw, rules);
  if (!newRun && state.clashGroupsKind === 'manual') {
    return {
      clashResult: result,
      clashGroups: state.clashGroups,
      clashGroupsKind: 'manual',
      clashExclusionCounts: counts,
      clashSuppressedCount: suppressed,
    };
  }
  const clashGroups = result ? groupClashes(result, { by: 'cluster', epsilon: clusterEpsilon }) : null;
  return {
    clashResult: result,
    clashGroups,
    clashGroupsKind: clashGroups ? 'derived' : null,
    clashExclusionCounts: counts,
    clashSuppressedCount: suppressed,
  };
}

export const createClashSlice: StateCreator<ClashSlice, [], [], ClashSlice> = (set, get) => {
  const initial = loadSettings();
  /**
   * Whether this session has already reported a refused settings write. Lives
   * in the store's closure, so "once" means once per store instance.
   */
  let settingsSaveFailureReported = false;
  /**
   * Persist the current settings snapshot after a state change.
   *
   * The caller has already committed the change with `set`, and that stays
   * committed even when the write is refused (quota, or storage blocked by the
   * browser's site settings): the detection controls are controlled inputs fed
   * from this state (`NumberField` / `Select` / `Switch` in
   * `ClashSettingsDialog.tsx`), so rolling the commit back would freeze the
   * field the user is typing into. What must not happen is the failure being
   * silent — the setting then reverts on the next reload with nothing said.
   *
   * So: commit, and report the refusal ONCE per session. Once, because these
   * setters fire per keystroke and per spinner step, and a per-write notice
   * would bury the user in duplicates of the same message.
   */
  const persistSettings = () => {
    const result = saveSettings(snapshotSettings(get()));
    if (result.ok || settingsSaveFailureReported) return;
    settingsSaveFailureReported = true;
    reportClashSettingsSaveFailure(result.message);
  };

  /**
   * Commit an exclusion-list change only if it persisted, then re-derive the
   * visible result from the untouched raw run.
   */
  const commitExclusions = (next: ClashExclusionRule[]): SaveResult => {
    const result = saveExclusions(next);
    if (!result.ok) return result;
    const state = get();
    set({
      clashExclusions: next,
      ...deriveGroups(state, state.clashRawResult, next, state.clashClusterEpsilon, false),
    });
    return result;
  };

  return {
    clashPanelVisible: false,
    clashResult: null,
    clashRawResult: null,
    clashGroups: null,
    clashGroupsKind: null,
    clashRunning: false,
    clashError: null,
    clashRunSeq: 0,
    clashProgress: null,
    clashMode: initial.mode,
    clashTolerance: initial.tolerance,
    clashDuplicateTolerance: initial.duplicateTolerance,
    clashClearance: initial.clearance,
    clashClusterEpsilon: initial.clusterEpsilon,
    clashReportTouch: initial.reportTouch,
    clashGroupBy: initial.groupBy,
    clashSortBy: 'severity',
    clashHideTouching: false,
    // Ghost (X-Ray context) by default so clicking a clash immediately reveals
    // the pair through the surrounding geometry instead of leaving it hidden
    // behind opaque elements: the "many times you won't see anything" problem
    // in #1466. The user can still switch to Highlight / Isolate in the panel.
    clashFocusMode: 'ghost',
    clashPresets: buildInitialPresets(),
    clashReviews: loadReviews(),
    clashStatusFilter: new Set(CLASH_REVIEW_STATUSES),
    clashExclusions: loadExclusions(),
    clashExclusionCounts: new Map<string, number>(),
    clashSuppressedCount: 0,
    clashSelectedId: null,
    clashHighlightColors: null,
    clashOverlapBox: null,
    clashContactLines: null,
    showClashRegionBox: true,

    setClashPanelVisible: (clashPanelVisible) => set({ clashPanelVisible }),
    toggleClashPanel: () => set((s) => ({ clashPanelVisible: !s.clashPanelVisible })),
    // Stores the RAW run and publishes the exclusion-filtered view (plus its
    // clusters) in the same commit, so no consumer can observe a result that
    // still contains clashes the user excluded.
    setClashResult: (raw) => {
      const state = get();
      set({
        clashRawResult: raw,
        ...deriveGroups(state, raw, state.clashExclusions, state.clashClusterEpsilon, true),
      });
    },
    setClashGroups: (clashGroups) => set({ clashGroups, clashGroupsKind: clashGroups ? 'manual' : null }),
    bumpClashRunSeq: () => set((s) => ({ clashRunSeq: s.clashRunSeq + 1 })),
    setClashRunning: (clashRunning) => set({ clashRunning }),
    setClashError: (clashError) => set({ clashError }),
    setClashProgress: (clashProgress) => set({ clashProgress }),

    setClashMode: (clashMode) => { set({ clashMode }); persistSettings(); },
    setClashTolerance: (clashTolerance) => {
      set({ clashTolerance: clampToBounds(clashTolerance, CLASH_BOUNDS.tolerance, DEFAULT_CLASH_SETTINGS.tolerance) });
      persistSettings();
    },
    setClashClearance: (clashClearance) => {
      set({ clashClearance: clampToBounds(clashClearance, CLASH_BOUNDS.clearance, DEFAULT_CLASH_SETTINGS.clearance) });
      persistSettings();
    },
    setClashDuplicateTolerance: (clashDuplicateTolerance) => {
      set({ clashDuplicateTolerance: clampToBounds(clashDuplicateTolerance, CLASH_BOUNDS.duplicateTolerance, DEFAULT_CLASH_SETTINGS.duplicateTolerance) });
      persistSettings();
    },
    setClashClusterEpsilon: (clashClusterEpsilon) => {
      const clamped = clampToBounds(clashClusterEpsilon, CLASH_BOUNDS.clusterEpsilon, DEFAULT_CLASH_SETTINGS.clusterEpsilon);
      const state = get();
      // clashGroups is otherwise derived only from setClashResult / commitExclusions
      // (deriveGroups), so without this the Issues view's radius control — which
      // now reads live from this same setting — silently did nothing. `newRun:
      // false` — deriveGroups leaves a 'manual' grouping (duplicate scan) alone.
      set({
        clashClusterEpsilon: clamped,
        ...deriveGroups(state, state.clashRawResult, state.clashExclusions, clamped, false),
      });
      persistSettings();
    },
    setClashReportTouch: (clashReportTouch) => { set({ clashReportTouch }); persistSettings(); },
    setClashGroupBy: (clashGroupBy) => { set({ clashGroupBy }); persistSettings(); },
    // View-state setters: kept in the store (not localStorage) so they survive a
    // panel switch within the session without growing the persisted blob. (#1464)
    setClashSortBy: (clashSortBy) => set({ clashSortBy }),
    setClashHideTouching: (clashHideTouching) => set({ clashHideTouching }),
    setClashFocusMode: (clashFocusMode) => set({ clashFocusMode }),
    resetClashSettings: () => {
      set({
        clashMode: DEFAULT_CLASH_SETTINGS.mode,
        clashTolerance: DEFAULT_CLASH_SETTINGS.tolerance,
        clashClearance: DEFAULT_CLASH_SETTINGS.clearance,
        clashDuplicateTolerance: DEFAULT_CLASH_SETTINGS.duplicateTolerance,
        clashClusterEpsilon: DEFAULT_CLASH_SETTINGS.clusterEpsilon,
        clashReportTouch: DEFAULT_CLASH_SETTINGS.reportTouch,
        clashGroupBy: DEFAULT_CLASH_SETTINGS.groupBy,
        showClashRegionBox: true,
      });
      persistSettings();
    },

    setClashSelectedId: (clashSelectedId) => set({ clashSelectedId }),
    setClashHighlightColors: (clashHighlightColors) => set({ clashHighlightColors }),
    setClashOverlapBox: (clashOverlapBox) => set({ clashOverlapBox }),
    setClashContactLines: (clashContactLines) => set({ clashContactLines }),
    setShowClashRegionBox: (showClashRegionBox) => set({ showClashRegionBox }),

    createClashPreset: (input) => {
      const name = validatePresetName(input.name);
      const selectorA = validateSelector(input.selectorA);
      const selectorB = validateSelector(input.selectorB);
      if (!name || !selectorA || !selectorB) {
        return { ok: false, reason: 'serialize', message: 'Name and both selectors are required.' };
      }
      const preset: ClashPreset = {
        id: `custom-${crypto.randomUUID()}`,
        name,
        description: input.description?.trim() ?? '',
        severity: input.severity,
        selectorA,
        selectorB,
        enabled: true,
        builtin: false,
      };
      const next = [...get().clashPresets, preset];
      const result = savePresets(next);
      if (result.ok) set({ clashPresets: next });
      return result;
    },

    updateClashPreset: (id, patch) => {
      const next = get().clashPresets.map((p) => (p.id === id ? { ...p, ...patch } : p));
      const result = savePresets(next);
      if (result.ok) set({ clashPresets: next });
      return result;
    },

    deleteClashPreset: (id) => {
      const target = get().clashPresets.find((p) => p.id === id);
      // Built-ins are reset, never deleted. Nothing was asked of storage, so
      // this is a success, not a failure the caller should report.
      if (!target || target.builtin) return { ok: true };
      const next = get().clashPresets.filter((p) => p.id !== id);
      const result = savePresets(next);
      if (result.ok) set({ clashPresets: next });
      return result;
    },

    setClashPresetEnabled: (id, enabled) => {
      const next = get().clashPresets.map((p) => (p.id === id ? { ...p, enabled } : p));
      const result = savePresets(next);
      if (result.ok) set({ clashPresets: next });
      return result;
    },

    resetClashPresets: () => {
      const next = defaultPresets(); // drops all overrides + customs
      const result = savePresets(next);
      if (result.ok) set({ clashPresets: next });
      return result;
    },

    importClashPresets: (presets) => {
      const next = [...get().clashPresets, ...presets.filter((p) => !p.builtin)];
      const result = savePresets(next);
      if (result.ok) set({ clashPresets: next });
      return result;
    },

    setClashReview: (key, patch) => {
      const map = new Map(get().clashReviews);
      const prev = map.get(key);
      const status = patch.status ?? prev?.status ?? DEFAULT_CLASH_REVIEW_STATUS;
      const comment = (patch.comment ?? prev?.comment ?? '').trim();
      // Default state (open, no comment) carries no information: drop the entry
      // so storage and the filter counts only reflect real decisions. (#1468)
      if (status === DEFAULT_CLASH_REVIEW_STATUS && comment.length === 0) {
        map.delete(key);
      } else {
        const review: ClashReview = { status, updatedAt: Date.now() };
        if (comment.length > 0) review.comment = comment;
        map.set(key, review);
      }
      const result = saveReviews(map);
      // Reflect the edit optimistically even if persistence hit quota, so the UI
      // stays responsive; the SaveResult lets the caller surface the failure.
      set({ clashReviews: map });
      return result;
    },

    addClashExclusion: (rule) => {
      const current = get().clashExclusions;
      const key = exclusionRuleKey(rule);
      const existing = current.find((r) => exclusionRuleKey(r) === key);
      if (existing) {
        // Same pair, either order, same granularity — already excluded. If the
        // existing rule is enabled, nothing was asked of storage, so this is a
        // success, not a failure to report. If it was DISABLED, re-clicking the
        // exclude button must re-enable it: otherwise the button looks broken
        // (no toast, no change, clashes stay visible).
        if (existing.enabled) return { ok: true };
        return commitExclusions(current.map((r) => (r.id === existing.id ? { ...r, enabled: true } : r)));
      }
      return commitExclusions([...current, rule]);
    },

    removeClashExclusion: (id) => {
      const current = get().clashExclusions;
      if (!current.some((r) => r.id === id)) return { ok: true };
      return commitExclusions(current.filter((r) => r.id !== id));
    },

    setClashExclusionEnabled: (id, enabled) =>
      commitExclusions(get().clashExclusions.map((r) => (r.id === id ? { ...r, enabled } : r))),

    clearClashExclusions: () => commitExclusions([]),

    toggleClashStatusFilter: (status) =>
      set((s) => {
        const next = new Set(s.clashStatusFilter);
        if (next.has(status)) next.delete(status);
        else next.add(status);
        return { clashStatusFilter: next };
      }),

    applyClashFlavorConfig: ({ presets, settings }) => {
      set({
        clashPresets: presets,
        clashMode: settings.mode,
        clashTolerance: settings.tolerance,
        clashClearance: settings.clearance,
        clashDuplicateTolerance: settings.duplicateTolerance,
        clashClusterEpsilon: settings.clusterEpsilon,
        clashReportTouch: settings.reportTouch,
        clashGroupBy: settings.groupBy,
      });
      // Persist so the activated flavor's config becomes the working set on reload.
      savePresets(presets);
      saveSettings(settings);
    },

    clearClash: () =>
      // Keep presets + settings (workspace prefs, like saved lenses): only the
      // run result/panel state is cleared.
      set({
        clashResult: null,
        clashRawResult: null,
        clashExclusionCounts: new Map<string, number>(),
        clashSuppressedCount: 0,
        clashGroups: null,
        clashGroupsKind: null,
        clashRunning: false,
        clashError: null,
        clashProgress: null,
        clashSelectedId: null,
        clashHighlightColors: null,
        clashOverlapBox: null,
    clashContactLines: null,
      }),
  };
};
