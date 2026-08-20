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
import type { ClashSolidDegenerateReason } from '@/lib/clash/intersection-solid';
import type { ClashVisibilityOwnership } from '@/lib/clash/visibility-ownership';

/**
 * Why the focused clash has no intersection solid to show. Extends the wasm
 * kernel's own `ClashSolidDegenerateReason` with one JS-only case: the
 * on-demand compute itself threw (an unexpected error, not a kernel verdict)
 * — kept distinct from the kernel's reasons so a UI string never claims the
 * kernel ruled on a pair it never actually got a verdict from.
 */
export type ClashSolidUnavailableReason = ClashSolidDegenerateReason | 'compute-error';

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
  presetsStoreIdentically,
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

  /**
   * Whether the focused clash's TRUE intersection volume (BIMcollab Zoom /
   * Solibri style opaque solid) is available for the 3D view:
   * - `none`: no clash focused.
   * - `computing`: `focusClash` kicked off the on-demand wasm compute; the
   *   existing contact marker (box/lines) is shown meanwhile so the user
   *   never sees "nothing" while it resolves.
   * - `solid`: the kernel resolved a solid — `clashSolidMesh` is populated
   *   and both parents should be ghosted so it reads against them.
   * - `unavailable`: the kernel could not resolve a solid (see
   *   `clashSolidReason` / `clashSolidThicknessM` / `clashSolidRequiredM`) —
   *   the existing contact marker stays the presentation, with a UI label
   *   explaining why so "no solid" doesn't read as "no clash".
   */
  clashSolidStatus: 'none' | 'computing' | 'solid' | 'unavailable';
  /** World-space intersection mesh, f64 positions. `null` unless `clashSolidStatus === 'solid'`. */
  clashSolidMesh: { positions: Float64Array; indices: Uint32Array } | null;
  /** Enclosed volume of the solid, m³. `0` unless `clashSolidStatus === 'solid'`. */
  clashSolidVolumeM3: number;
  /** Why no solid, when `clashSolidStatus === 'unavailable'`. `null` otherwise. */
  clashSolidReason: ClashSolidUnavailableReason | null;
  /** For `below-kernel-resolution`: measured thinnest extent, metres. `0` otherwise. */
  clashSolidThicknessM: number;
  /** For `below-kernel-resolution`: depth the kernel would have needed, metres. `0` otherwise. */
  clashSolidRequiredM: number;
  /**
   * Monotonic counter bumped by every store action that can invalidate an
   * in-flight `focusClash` solid compute: `setClashSelectedId` (the focused
   * clash changed or was cleared) and `clearClashSolid` / `clearClash` (the
   * presentation was torn down without a selection change, e.g. `selectElement`).
   * The async compute in `useClash.focusClash` captures this value right after
   * kicking off, and only writes its result if it is still current when the
   * promise settles — this makes the guard store state instead of a private
   * `useRef`, so ANY teardown path that resets the focused-clash presentation
   * invalidates the compute by construction, not just the ones that remembered
   * to call a specific cancel function (#2574 review: `tours/clash.ts` and
   * `store/homeView.ts` reset these same fields directly and neither could
   * reach a hook-private ref guard).
   */
  clashSolidRequestSeq: number;
  /**
   * Which SHARED visibility channel (`isolatedEntities` / `ghostExceptEntities`,
   * visibilitySlice) the clash presentation currently owns, and the exact
   * content it installed there. `null` when clash owns neither — including
   * after a `highlight`-mode focus, which clears both channels and takes
   * ownership of neither.
   *
   * Written by `useClash`'s two install helpers, read by
   * `releaseOwnedClashVisibility` (`lib/clash/visibility-ownership.ts`), which
   * is the single release both the hook's run-start discard and every
   * model-lifecycle teardown go through.
   *
   * It lives HERE, not in a `useRef` inside `useClash`, because the store-level
   * teardowns (`removeModel`, `clearAllModels`, `resetViewerState`) cannot read
   * a hook-private ref and were left inferring ownership from
   * `clashSelectedId` — a SELECTION fact, wrong in both directions (#2654 third
   * review; see the module doc on `visibility-ownership.ts`). Same shape as the
   * lens slice's `lensRuleIsolation` / `lensAppliedHiddenIds`, which record
   * lens ownership of these same channels in the store for the same reason.
   *
   * PART of `CLASH_FOCUS_RESET` (#2654 fourth review): ending a focus ends the
   * claim, so the by-hand "clear both channels" teardowns drop it without each
   * having to remember to. That is only safe because every caller releases
   * BEFORE it clears the focus — see the ordering note on `CLASH_FOCUS_RESET`.
   * The visibility CHANNELS stay out of that constant: `clearClashFocus()` also
   * runs at RUN START, where the release must stay ownership-aware (#2662 P2).
   */
  clashVisibilityOwned: ClashVisibilityOwnership;

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
  /** `focusClash` kicked off the on-demand solid compute for the pair now focused. */
  setClashSolidComputing: () => void;
  /** The compute resolved a solid. */
  setClashSolid: (mesh: { positions: Float64Array; indices: Uint32Array }, volumeM3: number) => void;
  /** The compute resolved a degenerate result — no solid to show. */
  setClashSolidUnavailable: (reason: ClashSolidUnavailableReason, thicknessM: number, requiredM: number) => void;
  /** Back to `'none'` — no clash focused. */
  clearClashSolid: () => void;
  /** Record (or drop) clash's claim on a shared visibility channel. Called by
   *  `useClash`'s install helpers and by `releaseOwnedClashVisibility`; nothing
   *  else should write it. */
  setClashVisibilityOwned: (owned: ClashVisibilityOwnership) => void;
  /**
   * End the focused-clash PRESENTATION entirely: the A/B pair tint, the contact
   * marker (lines + AABB box) and the intersection solid, plus the selected id
   * and the `clashSolidRequestSeq` bump that invalidates an in-flight compute.
   *
   * This is the ONLY complete spelling of "stop drawing the focused clash", and
   * every teardown path must call it rather than listing fields by hand. The
   * field list lived inline in seven callers and each one had drifted to a
   * different subset — `removeModel` cleared the solid but not the contact
   * marker, `ClashPanel`'s unmount cleared the box but not the lines — because
   * `Viewport.tsx` draws the marker from an effect keyed ONLY on
   * `clashContactLines`/`clashOverlapBox`, which reads neither `clashSelectedId`
   * nor `clashSolidStatus`. Dropping the solid therefore does NOT retract the
   * wireframe, and it hung in world space over models that were already gone
   * (#2654 review).
   *
   * Does NOT touch the clash RESULT (that is `clearClash`), nor the
   * ghost/isolation/colour-override channels, which are owned by other slices
   * and restored per-caller (an active lens must come back, not be blanked).
   */
  clearClashFocus: () => void;
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
   *
   * All-or-nothing: the two writes go to two independent localStorage keys, so
   * a refused write (quota, or storage blocked entirely) is undone and nothing
   * is committed to the store. Callers report `result.message`.
   */
  applyClashFlavorConfig: (config: { presets: ClashPreset[]; settings: ClashGlobalSettings }) => SaveResult;
  clearClash: () => void;
}

/**
 * The intersection-solid state machine at rest. One definition, spread by every
 * action that returns it to `'none'`, so a field added to the machine cannot be
 * forgotten by one of them.
 */
const CLASH_SOLID_RESET = {
  clashSolidStatus: 'none',
  clashSolidMesh: null,
  clashSolidVolumeM3: 0,
  clashSolidReason: null,
  clashSolidThicknessM: 0,
  clashSolidRequiredM: 0,
} as const satisfies Partial<ClashSlice>;

/**
 * Everything `focusClash` paints into the scene for ONE clash, at rest: the
 * solid plus the pair tint, the contact marker and the selected id. The single
 * source of truth behind `clearClashFocus` — and spread by `clearClash` too, so
 * the two can never drift into clearing different subsets.
 *
 * `clashVisibilityOwned` is here too — the CLAIM on the shared isolation/ghost
 * channels, not the channels themselves. Ending a focus ends the claim, whether
 * or not the caller also cleared the channel. Every by-hand "clear both channels"
 * path (`useClash.clearHighlight` / `clearAll`, `ClashPanel`'s unmount, the clash
 * tour cleanup, `homeView`) already routes through `clearClashFocus` /
 * `clearClash`, so all of them drop the claim by construction rather than by each
 * remembering to. Left standing, a stale record goes matching → cleared →
 * MATCHING AGAIN the moment another owner installs an equal set, and the next
 * model-lifecycle teardown destroys that owner's ghost (#2654 fourth review).
 *
 * This is safe ONLY because every caller releases before it clears:
 * `useClash.discardSolidPresentation` calls `releaseClashVisibility()` first,
 * and `endClashScenePresentation` (`lib/clash/visibility-ownership.ts`) releases
 * in its step 1 and clears in its step 2 — see the ordering note there. Clearing
 * first would null the record under the release, which would then find nothing
 * to release and silently leave clash's own ghost/isolation on screen.
 *
 * The visibility CHANNELS themselves stay out: `clearClashFocus()` also runs at
 * RUN START, where the release must stay ownership-aware so a user's X-ray
 * survives `run()` (#2662 P2, `useClash.run-preserves-isolation.test.tsx`).
 *
 * `clashSolidRequestSeq` is deliberately NOT here: it is a monotonic counter,
 * not a resettable field, and each action bumps it off its own current value.
 */
const CLASH_FOCUS_RESET = {
  ...CLASH_SOLID_RESET,
  clashSelectedId: null,
  clashHighlightColors: null,
  clashOverlapBox: null,
  clashContactLines: null,
  clashVisibilityOwned: null,
} as const satisfies Partial<ClashSlice>;

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
    clashSolidStatus: 'none',
    clashSolidMesh: null,
    clashSolidVolumeM3: 0,
    clashSolidReason: null,
    clashSolidThicknessM: 0,
    clashSolidRequiredM: 0,
    clashSolidRequestSeq: 0,
    clashVisibilityOwned: null,

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
      const state = get();
      set({
        clashMode: DEFAULT_CLASH_SETTINGS.mode,
        clashTolerance: DEFAULT_CLASH_SETTINGS.tolerance,
        clashClearance: DEFAULT_CLASH_SETTINGS.clearance,
        clashDuplicateTolerance: DEFAULT_CLASH_SETTINGS.duplicateTolerance,
        clashClusterEpsilon: DEFAULT_CLASH_SETTINGS.clusterEpsilon,
        clashReportTouch: DEFAULT_CLASH_SETTINGS.reportTouch,
        clashGroupBy: DEFAULT_CLASH_SETTINGS.groupBy,
        showClashRegionBox: true,
        // The cluster radius may have just changed, so the derived grouping
        // must follow in the same commit, like setClashClusterEpsilon, and
        // for the same reason: without this, existing derived results keep
        // the old radius until the next run. `newRun: false` leaves a manual
        // (duplicate-scan) grouping alone. (#2535)
        ...deriveGroups(
          state,
          state.clashRawResult,
          state.clashExclusions,
          DEFAULT_CLASH_SETTINGS.clusterEpsilon,
          false,
        ),
      });
      persistSettings();
    },

    // Changing (or clearing) which clash is focused always drops any
    // intersection-solid presentation for the PREVIOUS focus and bumps
    // `clashSolidRequestSeq`, invalidating any in-flight compute for it — see
    // the field doc above. `focusClash` re-applies `setClashSolidComputing()`
    // right after this for the newly selected clash, so the momentary `'none'`
    // here is never painted.
    setClashSelectedId: (clashSelectedId) =>
      set((s) => ({
        ...CLASH_SOLID_RESET,
        clashSelectedId,
        clashSolidRequestSeq: s.clashSolidRequestSeq + 1,
      })),
    setClashHighlightColors: (clashHighlightColors) => set({ clashHighlightColors }),
    setClashOverlapBox: (clashOverlapBox) => set({ clashOverlapBox }),
    setClashContactLines: (clashContactLines) => set({ clashContactLines }),
    setShowClashRegionBox: (showClashRegionBox) => set({ showClashRegionBox }),

    setClashSolidComputing: () =>
      set({
        clashSolidStatus: 'computing',
        clashSolidMesh: null,
        clashSolidVolumeM3: 0,
        clashSolidReason: null,
        clashSolidThicknessM: 0,
        clashSolidRequiredM: 0,
      }),
    setClashSolid: (mesh, volumeM3) =>
      set({
        clashSolidStatus: 'solid',
        clashSolidMesh: mesh,
        clashSolidVolumeM3: volumeM3,
        clashSolidReason: null,
        clashSolidThicknessM: 0,
        clashSolidRequiredM: 0,
      }),
    setClashSolidUnavailable: (reason, thicknessM, requiredM) =>
      set({
        clashSolidStatus: 'unavailable',
        clashSolidMesh: null,
        clashSolidVolumeM3: 0,
        clashSolidReason: reason,
        clashSolidThicknessM: thicknessM,
        clashSolidRequiredM: requiredM,
      }),
    clearClashSolid: () =>
      set((s) => ({
        ...CLASH_SOLID_RESET,
        clashSolidRequestSeq: s.clashSolidRequestSeq + 1,
      })),

    setClashVisibilityOwned: (clashVisibilityOwned) => set({ clashVisibilityOwned }),

    // The one complete "stop drawing the focused clash" — see the field doc on
    // the action type. Every teardown path routes through this instead of
    // listing fields, which is what stops the next one from clearing a subset.
    clearClashFocus: () =>
      set((s) => ({
        ...CLASH_FOCUS_RESET,
        clashSolidRequestSeq: s.clashSolidRequestSeq + 1,
      })),

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
      // Persist FIRST, commit only if both writes landed: a flavor whose config
      // is shown as applied but was refused by storage silently reverts to the
      // previous flavor's rules on the next reload.
      //
      // The two halves live under two independent localStorage keys and there is
      // no transaction across them, so a half-landed apply (new rule set, old
      // tolerances) is reachable. That state is not one the user can reason
      // about or even see is wrong, so it is undone rather than committed.
      // Presets go first because `savePresets` rejects an over-cap rule set
      // before it touches storage, which makes the common failure a clean no-op.
      const previousPresets = get().clashPresets;
      const presetsResult = savePresets(presets);
      if (!presetsResult.ok) return presetsResult; // nothing written, nothing to undo

      const settingsResult = saveSettings(settings);
      if (!settingsResult.ok) {
        // Put the previous rule set back so storage matches the store we are
        // about to leave untouched. This rewrites a payload that fit a moment
        // ago, in place of the one that just replaced it, so it should land.
        const undo = savePresets(previousPresets);
        // A failed undo only strands something if the write it was undoing
        // actually changed the stored bytes. A flavor can carry the rule set
        // that is already stored and differ only in its tolerances, and then
        // the presets write rewrote the same payload: storage still holds the
        // previous rule set beside the previous settings, which is exactly
        // what the store holds, so this is an ordinary refused settings write.
        // `presetsStoreIdentically` compares the payloads `savePresets` itself
        // builds, not the arrays, because `presetsToStore` drops unmodified
        // built-ins — two rule sets that differ as arrays can store the same.
        if (!undo.ok && !presetsStoreIdentically(previousPresets, presets)) {
          // The rollback failed too — realistic, since genuine quota exhaustion
          // (as opposed to one blocked key) leaves the disk full for the next
          // write as well. The store is still correct: nothing below this
          // branch runs, so the in-memory flavor never moved. But storage now
          // holds the NEW presets next to the OLD settings, a hybrid the user
          // never chose, and that pair rehydrates as-is on the next reload.
          //
          // There is no third write to retry and no snapshot beyond the one
          // that just failed to fall back to, so a bigger recovery mechanism
          // (re-reading storage back into the store, or a latch that refuses
          // further applies) would be reacting to a failure mode this rare —
          // a full quota surviving two consecutive writes — with a permanent
          // behavior change. What the caller (`ExtensionHostService`, see
          // `host.ts`) already does with a failed `SaveResult` is console.warn
          // it, matching every other refused write in this slice; enrich the
          // message so that warning names the real severity instead of
          // reading like an ordinary "settings not saved" refusal.
          //
          // `reason` carries the same distinction in machine-readable form.
          // Passing `settingsResult.reason` through would report `'quota'` for
          // both halves of this branch — genuine exhaustion is what fails a
          // rollback in the first place — leaving "recovered, storage is
          // consistent" and "stranded, storage is not" indistinguishable in
          // the only field a caller can branch on.
          console.warn(
            '[clash] flavor apply: could not restore the previous rule set after a refused settings write — storage now holds the new rule set with the previous settings:',
            undo.message,
          );
          return {
            ok: false,
            reason: 'rollback_failed',
            message:
              `${settingsResult.message} The previous rule set could also not be restored ` +
              `(${undo.message}), so saved data may no longer match what is shown.`,
          };
        }
        return settingsResult;
      }

      const state = get();
      set({
        clashPresets: presets,
        clashMode: settings.mode,
        clashTolerance: settings.tolerance,
        clashClearance: settings.clearance,
        clashDuplicateTolerance: settings.duplicateTolerance,
        clashClusterEpsilon: settings.clusterEpsilon,
        clashReportTouch: settings.reportTouch,
        clashGroupBy: settings.groupBy,
        // Regroup existing derived results at the flavor's cluster radius in
        // the same commit (see resetClashSettings; `newRun: false` preserves
        // a manual duplicate-scan grouping). (#2535)
        ...deriveGroups(
          state,
          state.clashRawResult,
          state.clashExclusions,
          settings.clusterEpsilon,
          false,
        ),
      });
      return { ok: true };
    },

    clearClash: () =>
      // Keep presets + settings (workspace prefs, like saved lenses): only the
      // run result plus the focused-clash presentation is cleared. The
      // presentation half is the shared `CLASH_FOCUS_RESET`, not a second hand-
      // written field list, so `clearClash` and `clearClashFocus` cannot drift
      // into clearing different subsets. The `clashSolidRequestSeq` bump comes
      // with it: an in-flight solid compute must be invalidated here too.
      set((s) => ({
        ...CLASH_FOCUS_RESET,
        clashResult: null,
        clashRawResult: null,
        clashExclusionCounts: new Map<string, number>(),
        clashSuppressedCount: 0,
        clashGroups: null,
        clashGroupsKind: null,
        clashRunning: false,
        clashError: null,
        clashProgress: null,
        clashSolidRequestSeq: s.clashSolidRequestSeq + 1,
      })),
  };
};
