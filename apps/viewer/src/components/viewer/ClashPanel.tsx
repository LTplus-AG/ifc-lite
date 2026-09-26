/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  X,
  Play,
  Square,
  Trash2,
  Crosshair,
  Copy,
  Info,
  Focus,
  ArrowUpDown,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Layers,
  MessageSquare,
  Ban,
  FolderPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useClash, type ClashFocusMode } from '@/hooks/useClash';
import { analysisStampOf, useAnalysisStaleness } from '@/hooks/useAnalysisStaleness';
import type { SaveResult } from '@/lib/clash/persistence';
import type { ClashExclusionKind } from '@/lib/clash/exclusions';
import { formatClashSolidVolumeM3 } from '@/lib/clash/clash-solid-volume-format';
import { useBCF } from '@/hooks/useBCF';
import { rerunClashRequest, rerunTooltip, runRequestOf } from '@/lib/clash/run-request';
import { releaseOwnedClashVisibility } from '@/lib/clash/visibility-ownership';
import { useViewerStore } from '@/store';
import { ModelBadge } from './ModelBadge';
import { ClashExportActions } from '@/components/viewer/clash/ClashExportActions';
import { ClashSettingsDialog } from '@/components/viewer/ClashSettingsDialog';
import { ClashRevisionCompareDialog } from '@/components/viewer/ClashRevisionCompareDialog';
import { ClashManualGroupDialog } from '@/components/viewer/ClashManualGroupDialog';
import { useManualClashGroups } from '@/components/viewer/useManualClashGroups';
import { ClashGroupingCheckbox, RemoveFromClashGroupButton } from '@/components/viewer/ClashManualGroupControls';
import { ClashGroupHeaderWithActions } from '@/components/viewer/ClashGroupHeaderWithActions';
import { ClashResultSummary, type ClashResultView } from '@/components/viewer/ClashResultSummary';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { duplicateSetSections } from '@/lib/clash/duplicate-set-sections';
import { clashDisplayRows, type ClashDisplaySection } from '@/lib/clash/display-rows';
import {
  isTouching, penetrationDepth,
  sortClashes,
  classifyRuleCoverage,
  describeEmptyRuleSides,
  ruleHadNoMatch,
  DUPLICATES_RULE,
  CLASH_REVIEW_STATUSES,
  type Clash,
  type ClashElementRef,
  type ClashReviewStatus,
  type ClashSeverity,
  type ClashSortBy,
} from '@ifc-lite/clash';
import { ClashModelTagNotice } from './ClashModelTagNotice';
import { ClashHelp } from './ClashHelp';
import { StaleResultBanner } from './StaleResultBanner';
import { useTranslation, type TranslationKey } from '@/i18n';

interface ClashPanelProps {
  onClose?: () => void;
}
type ClashSection = ClashDisplaySection;
const SEVERITY_ORDER: ClashSeverity[] = ['critical', 'major', 'minor', 'info'];
const SEVERITY: Record<ClashSeverity, { labelKey: TranslationKey; color: string }> = {
  critical: { labelKey: 'clashPanel.severity.critical', color: '#f7768e' }, major: { labelKey: 'clashPanel.severity.major', color: '#ff9e64' },
  minor: { labelKey: 'clashPanel.severity.minor', color: '#e0af68' }, info: { labelKey: 'clashPanel.severity.info', color: '#7aa2f7' },
};

const SORT_LABEL_KEY: Record<ClashSortBy, TranslationKey> = {
  severity: 'clashPanel.sort.severity', depth: 'clashPanel.sort.depth', distance: 'clashPanel.sort.distance',
};

/** Side A / B dots: the `clash-a` / `clash-b` tokens the 3D view tints the
 *  focused pair with (#1277, #5490), so each row reads as its element. */
const SIDE_DOT_CLASS = ['bg-clash-a', 'bg-clash-b'] as const;

/** Review-status presentation (#1468). Colours are orthogonal to severity: green
 *  = done, teal = accepted, muted = still open (the attention default). */
const REVIEW_STATUS: Record<ClashReviewStatus, { labelKey: TranslationKey; color: string }> = {
  open: { labelKey: 'clashPanel.reviewStatus.open', color: '#7aa2f7' }, resolved: { labelKey: 'clashPanel.reviewStatus.resolved', color: '#9ece6a' },
  accepted: { labelKey: 'clashPanel.reviewStatus.accepted', color: '#73daca' },
};

/** `typeAny`/`typePair`/`elementPair` exclusion-kind badges (#4918). */
const EXCLUSION_KIND_LABEL_KEY: Record<ClashExclusionKind, TranslationKey> = {
  typeAny: 'clashPanel.excluded.kindAny', typePair: 'clashPanel.excluded.kindType', elementPair: 'clashPanel.excluded.kindPair',
};

function shortName(key: string): string {
  return key.length > 10 ? `${key.slice(0, 8)}…` : key;
}

function formatDistance(distance: number): string {
  return distance < 0 ? `−${Math.abs(distance).toFixed(3)}m` : `${distance.toFixed(3)}m`;
}

/** A plain-language description of what a clash is and why it was flagged (#1276). */
function describeClash(c: Clash): string {
  if (c.rule === DUPLICATES_RULE.id) {
    return c.severity === 'major'
      ? 'Exact duplicate — coincident geometry with the same shape'
      : 'Overlapping — near-coincident objects in the same place';
  }
  if (c.status === 'clearance') {
    return `Clearance violation — ${c.distance.toFixed(3)} m gap, closer than required`;
  }
  if (isTouching(c)) {
    return 'Touching contact (≈0 m) — surfaces meet but barely overlap';
  }
  // An ABSENT `distanceKind` (results recorded before the field existed) is
  // not the same statement as an explicit `'estimate'`: the estimate wording
  // asserts the depth IS the AABB overlap, which an old record never said —
  // for those, say only that the provenance is unknown (review: #2536).
  if (c.distanceKind === undefined) {
    return `Hard clash — ~${penetrationDepth(c).toFixed(3)} m interpenetration (depth provenance unavailable)`;
  }
  // 'estimate' means the depth is a box dimension read off the AABBs, not a
  // mesh measurement (see Clash.distanceKind) — mark it so this does not
  // read as a precise interpenetration measurement.
  return c.distanceKind === 'estimate'
    ? `Hard clash — ~${penetrationDepth(c).toFixed(3)} m interpenetration (AABB estimate)`
    : `Hard clash — ${penetrationDepth(c).toFixed(3)} m interpenetration`;
}

/**
 * Per-clash review controls shown in an expanded row (#1468): a 3-way status
 * toggle plus an optional comment. Module-level (not nested in ClashPanel) so it
 * keeps its local comment draft across the parent's re-renders; the draft commits
 * to the store on blur. Resetting to Open with an empty comment drops the review.
 */
function ClashReviewControls({
  status,
  comment,
  onStatus,
  onComment,
}: {
  status: ClashReviewStatus;
  comment: string;
  onStatus: (s: ClashReviewStatus) => void;
  onComment: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(comment);
  // Re-sync if the stored comment changes from elsewhere (e.g. a status reset).
  useEffect(() => setDraft(comment), [comment]);
  const commit = () => {
    if (draft.trim() !== comment.trim()) onComment(draft);
  };
  return (
    <div className="mt-0.5 space-y-1.5 px-7 pb-1.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-2xs uppercase tracking-wide text-muted-foreground">{t('clashPanel.review.label')}</span>
        <div className="inline-flex overflow-hidden rounded-md border border-border text-2xs">
          {CLASH_REVIEW_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onStatus(s)}
              className={cn(
                'px-2 py-0.5 transition-colors',
                status === s ? 'font-medium text-background' : 'text-muted-foreground hover:bg-muted',
              )}
              style={status === s ? { background: REVIEW_STATUS[s].color } : undefined}
            >
              {t(REVIEW_STATUS[s].labelKey)}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={t('clashPanel.review.commentPlaceholder')}
        maxLength={2000}
        rows={2}
        className="w-full resize-y rounded border border-border bg-transparent px-2 py-1 text-2xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}

/**
 * "Everything touching this class" — one button per DISTINCT class of the
 * clash. Module-level (not nested in `ClashPanel`, like `ClashReviewControls`
 * above): a component defined inside a render body is a new function
 * identity every render, so React remounts the subtree instead of
 * reconciling it — harmless while these stay stateless, but the pattern
 * compounds every time another one gets added inside the panel body.
 */
function ExcludeAnyButton({ tag, count, onExclude }: { tag: string; count: number; onExclude: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onExclude}
      title={t('clashPanel.exclude.anyTagTooltip', { tag })}
      className="rounded border border-dashed border-border px-1.5 py-0.5 text-2xs hover:bg-muted"
    >
      {t('clashPanel.exclude.anyButton', { tag })}
      {count > 1 && <span className="ml-1 tabular-nums text-muted-foreground">({count})</span>}
    </button>
  );
}

/** The exclusion actions offered on an expanded clash, narrowest label last. Module-level, see `ExcludeAnyButton`. */
function ClashExclusionActions({
  clash,
  typeAnyCountOf,
  typePairCount,
  onExcludeTypeAny,
  onExcludeTypePair,
  onExcludeElementPair,
}: {
  clash: Clash;
  typeAnyCountOf: (tag: string) => number;
  typePairCount: number;
  onExcludeTypeAny: (tag: string) => void;
  onExcludeTypePair: () => void;
  onExcludeElementPair: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-7 pt-1.5">
      <Ban className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="text-2xs text-muted-foreground">{t('clashPanel.exclude.header')}</span>
      <ExcludeAnyButton tag={clash.a.tag} count={typeAnyCountOf(clash.a.tag)} onExclude={() => onExcludeTypeAny(clash.a.tag)} />
      {clash.b.tag !== clash.a.tag && (
        <ExcludeAnyButton tag={clash.b.tag} count={typeAnyCountOf(clash.b.tag)} onExclude={() => onExcludeTypeAny(clash.b.tag)} />
      )}
      <button
        onClick={onExcludeTypePair}
        title={t('clashPanel.exclude.pairTooltip', { tagA: clash.a.tag, tagB: clash.b.tag })}
        className="rounded border border-border px-1.5 py-0.5 text-2xs hover:bg-muted"
      >
        {t('clashPanel.exclude.pairButton', { tagA: clash.a.tag, tagB: clash.b.tag })}
        {typePairCount > 1 && <span className="ml-1 tabular-nums text-muted-foreground">({typePairCount})</span>}
      </button>
      <button
        onClick={onExcludeElementPair}
        title={t('clashPanel.exclude.elementTooltip')}
        className="rounded border border-border px-1.5 py-0.5 text-2xs hover:bg-muted"
      >
        {t('clashPanel.exclude.elementButton')}
      </button>
    </div>
  );
}

export function ClashPanel({ onClose }: ClashPanelProps) {
  const { t, revision } = useTranslation();
  const {
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
    presets,
    modelCount,
    statusFilter,
    reviewOf,
    reviewCommentOf,
    setReview,
    toggleStatusFilter,
    setMode,
    setTolerance,
    setClearance,
    setGroupBy,
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
    clearAll,
    exclusions,
    suppressedCount,
    exclusionCountOf,
    excludeTypePair,
    excludeTypeAny,
    excludeElementPair,
    removeExclusion,
    setExclusionEnabled,
    clearExclusions,
    invalidateSolidCompute,
  } = useClash();
  const rawResult = useViewerStore((s) => s.clashRawResult);
  const stale = useAnalysisStaleness(analysisStampOf(rawResult));

  // In-app BCF: create a topic from a clash without leaving the tool (#1279).
  const { createViewpointFromState, headerFilesForViewpoints } = useBCF();
  const bcfProject = useViewerStore((s) => s.bcfProject);
  const bcfAuthor = useViewerStore((s) => s.bcfAuthor);
  const setBcfProject = useViewerStore((s) => s.setBcfProject);
  const addTopic = useViewerStore((s) => s.addTopic);
  const addViewpoint = useViewerStore((s) => s.addViewpoint);
  const setBcfPanelVisible = useViewerStore((s) => s.setBcfPanelVisible);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Flat pairs vs. the existing spatial-cluster grouping (`groupClashes({ by:
   *  'cluster' })`, already computed into `groups` on every run for BCF export —
   *  this is the first time the RESULTS LIST itself surfaces it). View-only
   *  state: it doesn't change what was detected, only how it's displayed. */
  const [resultView, setResultView] = useState<ClashResultView>('pairs');
  const clusterEpsilon = useViewerStore((s) => s.clashClusterEpsilon);
  // View settings live in the store so they survive a panel switch (#1464).
  const sortBy = useViewerStore((s) => s.clashSortBy);
  const setSortBy = useViewerStore((s) => s.setClashSortBy);
  const hideTouching = useViewerStore((s) => s.clashHideTouching);
  const setHideTouching = useViewerStore((s) => s.setClashHideTouching);
  /** How the rest of the model is shown when a clash is focused (#1275). */
  const focusMode = useViewerStore((s) => s.clashFocusMode);
  const setFocusMode = useViewerStore((s) => s.setClashFocusMode);
  /** On-demand intersection-solid state for the focused clash — see `focusClash` in `useClash`. */
  const clashSolidStatus = useViewerStore((s) => s.clashSolidStatus);
  const clashSolidVolumeM3 = useViewerStore((s) => s.clashSolidVolumeM3);
  const clashSolidReason = useViewerStore((s) => s.clashSolidReason);
  const clashSolidThicknessM = useViewerStore((s) => s.clashSolidThicknessM);
  const clashSolidRequiredM = useViewerStore((s) => s.clashSolidRequiredM);
  const [showHelp, setShowHelp] = useState(false);
  const [creatingTopic, setCreatingTopic] = useState(false);
  // The whole detection-controls block is collapsible so the result list gets
  // vertical room: auto-open before the first run (discoverability), auto-collapse
  // once a result is on screen, with a manual override once the user toggles it.
  const [controlsOverride, setControlsOverride] = useState<boolean | null>(null);

  // Clear the clash colours + overlap box when the panel closes/unmounts so they
  // don't linger on the model after the user leaves clash mode. Restore the
  // colour-override channel to an active lens (if any) rather than blanking it. (#1277)
  useEffect(() => () => {
    const s = useViewerStore.getState();
    // Release only the isolation/ghost CLASH installed (#5829): a storey isolation
    // or X-ray set elsewhere survives, as for runs (`discardSolidPresentation`).
    s.clearEntitySelection();
    releaseOwnedClashVisibility(s);
    // One call, not a field list: this cleanup used to clear the selected id,
    // the pair tint, the overlap box and the solid but NOT `clashContactLines`,
    // so a focused clash whose contact interface HAD been built (the preferred
    // marker — `useClash` sets the lines and nulls the box in that case) left
    // its outline drawn after the panel unmounted (#2654 review).
    s.clearClashFocus();
    s.setPendingColorUpdates(s.lensAppliedColors ?? new Map());
    // Drop any in-flight solid compute too — without this, a compute kicked
    // off just before the panel closes can resolve AFTER this cleanup runs
    // and re-apply a solid + full-model ghost onto a view the user already
    // left (the leaked-ghosting bug this whole feature is most at risk of).
    invalidateSolidCompute();
  }, [invalidateSolidCompute]);

  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Touching (≈0 m contact) count — surfaced so the user can choose to hide them. */
  const touchingCount = useMemo(
    () => (result ? result.clashes.filter((c) => isTouching(c)).length : 0),
    [result],
  );

  /** Count of clashes in each review status (over the whole result), for the
   *  filter chips. Recomputes when a review changes. (#1468) */
  const reviewCounts = useMemo(() => {
    const counts: Record<ClashReviewStatus, number> = { open: 0, resolved: 0, accepted: 0 };
    if (result) for (const c of result.clashes) counts[reviewOf(c)] += 1;
    return counts;
  }, [result, reviewOf]);

  /** The clashes actually shown: touching + status filters applied, then ordered by `sortBy`. */
  const visibleClashes = useMemo(() => {
    if (!result) return [] as Clash[];
    let list = hideTouching ? result.clashes.filter((c) => !isTouching(c)) : result.clashes;
    // Status filter: skip the per-clash lookup entirely when all statuses show (default).
    if (statusFilter.size < CLASH_REVIEW_STATUSES.length) {
      list = list.filter((c) => statusFilter.has(reviewOf(c)));
    }
    return sortClashes(list, sortBy);
  }, [result, hideTouching, sortBy, statusFilter, reviewOf]);

  // A duplicate scan renders one section per coincident SET ("3 coincident
  // IfcColumn objects" holding its pair rows) instead of the generic
  // severity/rule/typePair buckets — the pairwise rows alone overstate N
  // copies as N(N−1)/2 sibling findings (#2530). Falls through to the generic
  // sections for every other run (and if the grouping is stale). Computed
  // separately from `sections` so the "Group by" control can tell whether it
  // is actually in effect (review: the select kept re-running this memo and
  // changing `groupBy` without ever affecting the rendered list).
  const setSections = useMemo(
    () => duplicateSetSections(result, groups, visibleClashes),
    [result, groups, visibleClashes],
  );
  const isDuplicateSetView = setSections !== null;
  // A duplicate scan's grouping is coincident SETS, not spatial proximity, so
  // the Pairs/Issues toggle and its epsilon wording do not apply there, and a
  // stale 'issues' choice from an earlier clash scan must not leak in either
  // (`resultView` is component state that survives a result change). (#2535)
  const effectiveResultView = isDuplicateSetView && resultView === 'issues' ? 'pairs' : resultView;

  // Group the (filtered, sorted) clash list for display along the selected dimension.
  // Items keep their sorted order within each bucket.
  const sections = useMemo<ClashSection[]>(() => {
    if (!result) return [] as ClashSection[];
    if (setSections) {
      return setSections.map((s) => ({
        key: s.key,
        label: s.label,
        color: SEVERITY[s.severity].color,
        items: s.items,
      }));
    }
    const buckets = new Map<string, Clash[]>();
    for (const c of visibleClashes) {
      const key =
        groupBy === 'severity'
          ? c.severity
          : groupBy === 'rule'
            ? c.rule
            : [c.a.tag, c.b.tag].sort().join(' × ');
      const list = buckets.get(key);
      if (list) list.push(c);
      else buckets.set(key, [c]);
    }
    const entries = [...buckets.entries()];
    if (groupBy === 'severity') {
      entries.sort((a, b) => SEVERITY_ORDER.indexOf(a[0] as ClashSeverity) - SEVERITY_ORDER.indexOf(b[0] as ClashSeverity));
    } else {
      entries.sort((a, b) => b[1].length - a[1].length);
    }
    // Map rule id → human name for "By rule" labels. rulesRun covers every rule
    // that actually ran — discipline presets, custom presets, the synthetic
    // "all-clashes" and the duplicate scan — so no hardcoding is needed.
    const ruleNames = new Map(result.rulesRun.map((r) => [r.id, r.name]));
    return entries.map(([key, items]) => ({
      key,
      label:
        groupBy === 'severity'
          ? t(SEVERITY[key as ClashSeverity].labelKey)
          : groupBy === 'rule'
            ? ruleNames.get(key) ?? key
            : key,
      color: groupBy === 'severity' ? SEVERITY[key as ClashSeverity].color : undefined,
      items,
    }));
  }, [result, setSections, visibleClashes, groupBy, t, revision]);

  /**
   * The same (filtered, sorted) clashes re-organized along the existing spatial
   * clustering (`groups`, from `groupClashes({ by: 'cluster' })`) instead of
   * severity/rule/type-pair — one section per coordination issue rather than per
   * raw pair. A group can straddle the current filters (touching/status), so
   * only its VISIBLE members are shown and empty groups are dropped; the pairs
   * inside are never removed, only re-organized (issue #groupClashes-ui).
   */
  const issueSections = useMemo<ClashSection[]>(() => {
    if (!groups) return [] as ClashSection[];
    const visibleIds = new Set(visibleClashes.map((c) => c.id));
    return groups
      .map((g) => ({
        key: g.id,
        label: g.title,
        color: SEVERITY[g.severity].color,
        items: sortClashes(
          g.members.filter((m) => visibleIds.has(m.id)),
          sortBy,
        ),
      }))
      .filter((s) => s.items.length > 0);
  }, [groups, visibleClashes, sortBy]);

  const showManualGroups = useCallback(() => setResultView('groups'), []);
  const {
    sections: manualSections, groupCount: manualGroupCount, membersById: manualMembersById,
    selected: selectedClashes, checkedIds: checkedClashIds, setCheckedIds: setCheckedClashIds,
    dialog: groupDialog, setDialog: setGroupDialog, openCreate: openCreateGroupDialog, openAddToGroup,
    submitDialog: submitGroupDialog, removeGroup: removeManualGroup, dialogProps,
    removeMember: removeManualGroupMember, createBcfTopic: createBcfTopicForGroup,
  } = useManualClashGroups({
    clashes: result?.clashes, visibleClashes, sortBy, focusMode, focusClashes, creatingTopic, setCreatingTopic,
    showGroups: showManualGroups,
  });
  const activeSections = effectiveResultView === 'issues'
    ? issueSections
    : effectiveResultView === 'groups'
      ? manualSections
      : sections;

  const total = result?.summary.total ?? 0;
  const shown = visibleClashes.length;
  // Filter-aware: `groups.length` would count clusters that the touching/status
  // filters have emptied out, so the header would say "2 issues" while the list
  // below (built from the same `issueSections`) renders only 1.
  const issueCount = issueSections.length;
  const bySeverity = result?.summary.bySeverity;

  // Case (c) from the clash-matrix design: "0 clashes" because no rule matched
  // any elements in this model reads as "your model is clean" unless we say
  // otherwise. `classifyRuleCoverage` distinguishes that from a genuine
  // zero-clash result; the panel only needs the loud 'no-match' case plus the
  // list of empty rule names for a short explanation.
  const coverageOutcome = useMemo(
    () => (result ? classifyRuleCoverage(result) : 'unknown'),
    [result],
  );
  const emptyRuleNames = useMemo(() => {
    if (!result?.ruleCoverage) return [] as string[];
    const names = new Map(result.rulesRun.map((r) => [r.id, r.name]));
    return result.ruleCoverage.filter(ruleHadNoMatch).map((c) => names.get(c.rule) ?? c.rule);
  }, [result]);
  // Describes WHICH side(s) matched nothing, per empty rule — used when the
  // run was a single ad-hoc rule (`runAll`/`runPreset`, one rule), where "the
  // matrix didn't apply" would be a false claim: there was no matrix, just one
  // rule whose A or B side doesn't describe this model. The wording lives in
  // the clash package because only its coverage says whether a side was a
  // selector or a resolved filter (#3902).
  const emptySelectorDescriptions = useMemo(() => {
    if (!result?.ruleCoverage) return [] as string[];
    const rules = new Map(result.rulesRun.map((r) => [r.id, r]));
    return result.ruleCoverage
      .filter(ruleHadNoMatch)
      .map((c) => describeEmptyRuleSides(rules.get(c.rule), c));
  }, [result]);
  // Only a real multi-rule discipline-matrix run (`runMatrix`) can be
  // truthfully described as "the matrix didn't run" — a single ad-hoc rule
  // (`runAll`'s self-clash, or a one-off `runPreset`) never involved a
  // matrix at all, so that case must name the empty selector instead.
  const isMultiRuleRun = (result?.rulesRun.length ?? 0) > 1;

  // Flatten sections → a single row list (group header, clash row, and an
  // expanded-detail row for opened clashes) so the list virtualizes cleanly and
  // stays smooth at 10k+ clashes. Collapsed sections contribute only their
  // header. (#1277 list handling)
  const displayRows = useMemo(
    () => clashDisplayRows(activeSections, collapsed, expanded),
    [activeSections, collapsed, expanded],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const r = displayRows[i];
      // Detail rows carry the two element rows plus the review controls (#1468).
      return r.kind === 'group' ? 32 : r.kind === 'detail' ? 214 : 52;
    },
    overscan: 16,
    getItemKey: (i) => {
      const r = displayRows[i];
      return r.kind === 'group' ? `g:${r.key}` : r.kind === 'detail' ? `d:${r.clash.id}` : `c:${r.clash.id}`;
    },
  });

  /**
   * Create a BCF topic from the selected clash (or the whole result) directly in
   * the in-app issue tracker — no download/re-import round-trip (#1279). The
   * clash is framed + selected first so the captured viewpoint shows it.
   */
  const createBcfTopic = useCallback(async (): Promise<void> => {
    if (!result || creatingTopic) return;
    const clash = selectedId ? result.clashes.find((c) => c.id === selectedId) ?? null : null;
    setCreatingTopic(true);
    try {
      if (clash) {
        focusClash(clash, focusMode);
        // Wait for the camera move + a render before grabbing the snapshot.
        // FRAME-WAIT-ALLOW(#2385): must NOT be raced against a timer — timing out
        // would attach a pre-camera-move frame to the BCF topic. A hidden tab
        // cannot present the moved camera at all, so bounding this buys nothing.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      if (!bcfProject) setBcfProject(createBCFProject({ name: 'Clash report' }));
      const title = clash
        ? `Clash: ${clash.a.tag} × ${clash.b.tag}`
        : `Clash report — ${total} ${total === 1 ? 'clash' : 'clashes'}`;
      const description = clash
        ? `${describeClash(clash)}\n${clash.a.name ?? clash.a.key} ↔ ${clash.b.name ?? clash.b.key}`
        : `${total} ${total === 1 ? 'clash' : 'clashes'} detected across the loaded model(s).`;
      const topic = createBCFTopic({ title, description, author: bcfAuthor, topicType: 'Clash', topicStatus: 'Open' });
      // `focusClash` above paints the pair through the clash colour channel,
      // not the selection (#1277/#1339); `createViewpointFromState` turns that
      // into the viewpoint's found objects and colouring (#4806).
      const vp = await createViewpointFromState({ includeSnapshot: true, includeSelection: true, includeHidden: true });
      // Record the source model(s) the clash spans, as the BCF panel does (#1591).
      const header = headerFilesForViewpoints(vp ? [vp] : [], topic.creationDate);
      if (header.length > 0) topic.header = header;
      addTopic(topic);
      if (vp) addViewpoint(topic.guid, vp);
      toast.success(t('clashTools.bcfTopic.created'), { label: t('clashTools.bcfTopic.open'), onClick: () => setBcfPanelVisible(true) });
    } catch (err) {
      console.error('[clash] BCF topic creation failed', err);
    } finally {
      setCreatingTopic(false);
    }
  }, [result, creatingTopic, selectedId, focusClash, focusMode, bcfProject, setBcfProject, total, bcfAuthor, addTopic, createViewpointFromState, headerFilesForViewpoints, addViewpoint, setBcfPanelVisible, t]);

  /** Switch the focus mode and immediately re-apply it to the selected clash so
   *  the change is visible without re-clicking the row (#1275). */
  const changeFocusMode = useCallback(
    (mode: ClashFocusMode): void => {
      setFocusMode(mode);
      const current = selectedId ? result?.clashes.find((c) => c.id === selectedId) : undefined;
      if (current) focusClash(current, mode);
    },
    [selectedId, result, focusClash],
  );

  /** Set a review and surface a quota/serialize failure instead of dropping it
   *  (the edit still shows in-session; the toast says it was not saved). (#1468) */
  const applyReview = useCallback(
    (clash: Clash, patch: { status?: ClashReviewStatus; comment?: string }): void => {
      const res = setReview(clash, patch);
      if (!res.ok) toast.error(res.message);
    },
    [setReview],
  );

  /** Add an exclusion, surfacing a refused write instead of dropping it. */
  const applyExclusion = useCallback((add: () => SaveResult): void => {
    const res = add();
    if (!res.ok) toast.error(res.message);
  }, []);

  /**
   * How many clashes of the CURRENT (already exclusion-filtered) result share a
   * type pair — i.e. how many a type-pair rule would remove right now. Read off
   * the result summary, whose bucket key is the sorted `"<tag> vs <tag>"` pair.
   */
  const typePairCount = useCallback(
    (clash: Clash): number => result?.summary.byTypePair[[clash.a.tag, clash.b.tag].sort().join(' vs ')] ?? 0,
    [result],
  );

  /**
   * How many clashes of the CURRENT result touch a given IFC class on EITHER
   * side — the reach of a one-sided rule. Counted off the clash list rather
   * than summed out of `byTypePair`, whose keys are a joined string and would
   * have to be parsed back apart.
   */
  const typeAnyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of result?.clashes ?? []) {
      const tags = c.a.tag === c.b.tag ? [c.a.tag] : [c.a.tag, c.b.tag];
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return counts;
  }, [result]);

  /** One side (A or B) of a clash inside the expanded row (#1276). */
  const ElementRow = ({ el, side }: { el: ClashElementRef; side: 0 | 1 }) => (
    <button
      onClick={() => selectElement(el, focusMode)}
      title={`${el.tag} · ${el.name ?? el.key}`}
      className="flex w-full items-center gap-2 py-1 pl-7 pr-3 text-left hover:bg-muted/50"
    >
      <span data-clash-side={side === 0 ? 'a' : 'b'} className={cn('h-2 w-2 rounded-full shrink-0', SIDE_DOT_CLASS[side])} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-2xs text-foreground">{el.tag}</div>
        <div className="truncate text-2xs text-muted-foreground">{el.name ?? shortName(el.key)}</div>
        {/* Federated clashes carry each side's source model (#1591); show it
            only in a federation so single-model lists stay uncluttered. */}
        {modelCount > 1 && <ModelBadge modelId={el.model} className="mt-0.5 max-w-full" />}
      </div>
      <Focus className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <Crosshair className="h-4 w-4 text-clash-overlap shrink-0" />
        <span className="text-sm font-semibold tracking-tight min-w-0">{t('clashPanel.title')}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <IconButton
            label={t('clashPanel.helpTooltip')}
            className={cn('h-7 w-7', showHelp && 'text-primary')}
            onClick={() => setShowHelp((v) => !v)}
          >
            <Info className="h-4 w-4" />
          </IconButton>
          <ClashSettingsDialog />
          <ClashRevisionCompareDialog />
          {result && (
            <IconButton label={t('clashPanel.clearResultsTooltip')} className="h-7 w-7" onClick={clearAll}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          )}
          {onClose && (
            <IconButton label={t('clashPanel.closeTooltip')} className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      </div>

      {showHelp && <ClashHelp />}

      {/* Run controls — collapse to a slim bar once a result exists so the list
          gets vertical room; expand (or before the first run) shows full setup. */}
      {(() => {
        // With no result there is nothing to collapse for and the run controls are
        // the only way forward, so force them open (ignoring any pinned override);
        // once a result exists, default collapsed with the user's override winning.
        const controlsOpen = result == null ? true : (controlsOverride ?? false);
        return (
      <div className="p-3 space-y-3 border-b border-border">
        {result && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setControlsOverride(!controlsOpen)}
              aria-expanded={controlsOpen}
              className="flex flex-1 items-center gap-1.5 text-2xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              {controlsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <span>{t('clashPanel.detectionSectionLabel')}</span>
              <span className="normal-case tracking-normal text-muted-foreground">{mode}</span>
            </button>
            {!controlsOpen && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={running ? cancelRun : () => void rerunClashRequest(runRequestOf(result), { runAll, runMatrix, runPreset, runDuplicates })}
                title={running ? t('clashPanel.cancel') : rerunTooltip(t, runRequestOf(result))}
              >
                {running ? <Square className="h-3.5 w-3.5 mr-1" /> : <Crosshair className="h-3.5 w-3.5 mr-1" />}
                {t(running ? 'clashPanel.cancel' : 'clashPanel.rerun')}
              </Button>
            )}
          </div>
        )}

        {controlsOpen && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-border overflow-hidden text-xs shrink-0">
                {(['hard', 'clearance'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      'px-2.5 py-1 capitalize transition-colors',
                      mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1 text-xs text-muted-foreground" title={t('clashPanel.tolLabelTooltip')}>
                {t('clashPanel.help.tolAbbrev')}
                <input
                  type="number"
                  step={0.001}
                  min={0}
                  value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value))}
                  className="w-16 rounded border border-border bg-transparent px-1.5 py-0.5 text-foreground"
                />
              </label>
              {mode === 'clearance' && (
                <label className="flex items-center gap-1 text-xs text-muted-foreground" title={t('clashPanel.gapLabelTooltip')}>
                  {t('clashPanel.help.gapAbbrev')}
                  <input
                    type="number"
                    step={0.01}
                    min={0}
                    value={clearance}
                    onChange={(e) => setClearance(Number(e.target.value))}
                    className="w-16 rounded border border-border bg-transparent px-1.5 py-0.5 text-foreground"
                  />
                </label>
              )}
            </div>

            <Button className="w-full h-8" onClick={running ? cancelRun : () => void runAll()} {...tourAnchor(TOUR_ANCHORS.clashRun)}>
              {running ? <Square className="h-4 w-4 mr-1.5" /> : <Crosshair className="h-4 w-4 mr-1.5" />}
              {t(running ? 'clashPanel.cancel' : 'clashPanel.detectAll')}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 h-7 text-xs"
                disabled={running}
                onClick={() => void runDuplicates()}
                title={t('clashPanel.findDuplicatesTooltip')}
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                {t('clashPanel.findDuplicates')}
              </Button>
              <Button
                variant="outline"
                className="flex-1 h-7 text-xs"
                disabled={running}
                onClick={() => void runMatrix()}
                title={t('clashPanel.disciplineMatrixTooltip')}
              >
                <Play className="h-3.5 w-3.5 mr-1.5" />
                {t('clashPanel.disciplineMatrix')}
              </Button>
            </div>

            {presets.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    disabled={running}
                    onClick={() => void runPreset(p.id)}
                    title={p.description}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs transition-colors',
                      'border-border hover:bg-muted disabled:opacity-50',
                    )}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: SEVERITY[p.severity].color }} />
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Live progress — the engine yields between chunks so this paints even
            on large models that take a while (#1281). */}
        {running && progress && (() => {
          const determinate = progress.total > 0;
          const pct = determinate ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
          const label = determinate
            ? t('clashPanel.progress.checking', { done: progress.done.toLocaleString(), total: progress.total.toLocaleString() })
            : t('clashPanel.progress.preparing');
          return (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-2xs text-muted-foreground">
                <span className="truncate">{label}</span>
                {determinate && <span className="tabular-nums">{pct}%</span>}
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full bg-[#f7768e]', determinate ? 'transition-[width] duration-150' : 'w-2/5 animate-pulse')}
                  style={determinate ? { width: `${pct}%` } : undefined}
                />
              </div>
            </div>
          );
        })()}
      </div>
        );
      })()}

      {error && (
        <div className="flex items-start gap-2 m-3 p-2 rounded-md bg-[#f7768e]/10 text-[#f7768e] text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      <ClashModelTagNotice />

      {result && stale && (
        <StaleResultBanner
          disabled={running}
          onRerun={() => { void rerunClashRequest(runRequestOf(result), { runAll, runMatrix, runPreset, runDuplicates }); }}
        />
      )}

      {/* Summary */}
      {result && (
        <div className={cn('px-3 py-2.5 border-b border-border', stale && 'opacity-60')} {...tourAnchor(TOUR_ANCHORS.clashSummary)}>
          <ClashResultSummary
            total={total}
            shown={shown}
            issueCount={issueCount}
            manualGroupCount={manualGroupCount}
            resultView={resultView}
            effectiveView={effectiveResultView}
            setResultView={setResultView}
            clusterEpsilon={clusterEpsilon}
            groupsAvailable={groups != null}
            duplicateSetView={isDuplicateSetView}
            bySeverity={bySeverity}
          />
        </div>
      )}

      {/* Toolbar: group-by + sort + actions */}
      {result && total > 0 && (
        <div className="px-3 py-2 border-b border-border text-xs space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Layers className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {effectiveResultView === 'issues' ? (
              <span className="text-muted-foreground" title={t('clashPanel.clusterRadiusTooltip', { epsilon: clusterEpsilon })}>
                {t('clashPanel.groupedByProximity')}
              </span>
            ) : effectiveResultView === 'groups' ? (
              <span className="text-muted-foreground">{t('clashPanel.userDefinedGroups')}</span>
            ) : (
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
                disabled={isDuplicateSetView}
                title={
                  isDuplicateSetView
                    ? t('clashPanel.duplicateScanGroupTooltip')
                    : undefined
                }
                className="min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="severity">{t('clashPanel.groupBySeverityOption')}</option>
                <option value="rule">{t('clashPanel.groupByRuleOption')}</option>
                <option value="typePair">{t('clashPanel.groupByTypePairOption')}</option>
              </select>
            )}
            <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as ClashSortBy)}
              className="min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5"
            >
              {(['severity', 'depth', 'distance'] as ClashSortBy[]).map((s) => (
                <option key={s} value={s}>{t(SORT_LABEL_KEY[s])}</option>
              ))}
            </select>
            <ClashExportActions selectedId={selectedId} creatingTopic={creatingTopic} createBcfTopic={createBcfTopic} />
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-2xs"
              disabled={selectedClashes.length < 2}
              title={t('clashPanel.groupSelectedTooltip')}
              onClick={openCreateGroupDialog}
            >
              <FolderPlus className="mr-1 h-3.5 w-3.5" />
              {t('clashPanel.groupSelectedButton')}{selectedClashes.length > 0 ? ` (${selectedClashes.length})` : ''}
            </Button>
          </div>
          {/* Filters: touching + review status, grouped so "what's shown" reads
              as one control cluster (#1468). */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-muted-foreground">
            <label className="inline-flex items-center gap-1.5 cursor-pointer" title={t('clashPanel.hideTouchingTooltip')}>
              <input type="checkbox" checked={hideTouching} onChange={(e) => setHideTouching(e.target.checked)} className="accent-[#f7768e]" />
              {t('clashPanel.hideTouchingLabel')}{touchingCount > 0 ? ` (${touchingCount})` : ''}
            </label>
            <span className="h-3.5 w-px bg-border" aria-hidden="true" />
            {CLASH_REVIEW_STATUSES.map((s) => {
              const on = statusFilter.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStatusFilter(s)}
                  aria-pressed={on}
                  title={t('clashPanel.statusFilterTooltip', { action: t(on ? 'clashPanel.action.hide' : 'clashPanel.action.show'), status: t(REVIEW_STATUS[s].labelKey).toLowerCase() })}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs transition-colors',
                    on ? 'border-transparent text-foreground' : 'border-border opacity-60 hover:opacity-100',
                  )}
                  style={on ? { background: `${REVIEW_STATUS[s].color}1f`, borderColor: `${REVIEW_STATUS[s].color}66` } : undefined}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: REVIEW_STATUS[s].color }} />
                  {t(REVIEW_STATUS[s].labelKey)}
                  <span className="tabular-nums opacity-70">{reviewCounts[s]}</span>
                </button>
              );
            })}
          </div>
          {/* View: on-select focus mode + bulk highlight / clear. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <div className="inline-flex items-center gap-1" title={t('clashPanel.focusModeTooltip')} {...tourAnchor(TOUR_ANCHORS.clashFocusMode)}>
              <span>{t('clashPanel.onSelectLabel')}</span>
              <div className="inline-flex rounded-md border border-border overflow-hidden">
                {([
                  ['highlight', 'clashPanel.focusMode.highlightLabel', 'clashPanel.focusMode.highlightTooltip'],
                  ['isolate', 'clashPanel.focusMode.isolateLabel', 'clashPanel.focusMode.isolateTooltip'],
                  ['ghost', 'clashPanel.focusMode.ghostLabel', 'clashPanel.focusMode.ghostTooltip'],
                ] as [ClashFocusMode, TranslationKey, TranslationKey][]).map(([m, labelKey, tipKey]) => (
                  <button
                    key={m}
                    title={t(tipKey)}
                    onClick={() => changeFocusMode(m)}
                    className={cn(
                      'px-1.5 py-0.5 transition-colors',
                      focusMode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                    )}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" title={t('clashPanel.highlightAllTooltip')} onClick={highlightAll}>
                {t('clashPanel.highlightAllButton')}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" title={t('clashPanel.clearHighlightTooltip')} onClick={clearHighlight}>
                {t('clashPanel.clearButton')}
              </Button>
            </div>
          </div>
          {selectedId && clashSolidStatus !== 'none' && (
            <div className="text-2xs text-muted-foreground" data-testid="clash-solid-status">
              {clashSolidStatus === 'computing' && t('clashPanel.solid.computing')}
              {clashSolidStatus === 'solid' && t('clashPanel.solid.shown', { volume: formatClashSolidVolumeM3(clashSolidVolumeM3) })}
              {clashSolidStatus === 'unavailable' && (
                <>
                  {clashSolidReason === 'below-kernel-resolution'
                    ? t('clashPanel.solid.belowResolution', { thickness: (clashSolidThicknessM * 1000).toFixed(2), required: (clashSolidRequiredM * 1000).toFixed(2) })
                    : clashSolidReason === 'no-overlap'
                      ? t('clashPanel.solid.noOverlap')
                      : clashSolidReason === 'empty-operand'
                        ? t('clashPanel.solid.emptyOperand')
                        : t('clashPanel.solid.unknown')}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* The user's own exclusions: what is hidden, how much, and how to undo it.
          Always listed while any rule exists — a suppression the user cannot see
          is indistinguishable from a detector that missed something. */}
      {exclusions.length > 0 && (
        <div className="border-b border-border bg-muted/20 px-3 py-1.5 text-2xs">
          <div className="flex items-center gap-1.5">
            <Ban className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="font-medium">{t('clashPanel.excluded.header')}</span>
            <span className="text-muted-foreground">
              {t('clashPanel.excluded.summary', { count: exclusions.length })}
              {suppressedCount > 0 && t('clashPanel.excluded.hiddenSuffix', { count: suppressedCount })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-5 px-1.5 text-2xs"
              title={t('clashPanel.excluded.clearAllTooltip')}
              onClick={() => applyExclusion(clearExclusions)}
            >
              {t('clashPanel.excluded.clearAllButton')}
            </Button>
          </div>
          <ul className="mt-1 max-h-24 space-y-0.5 overflow-auto">
            {exclusions.map((rule) => {
              const n = exclusionCountOf(rule);
              return (
                <li key={rule.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => applyExclusion(() => setExclusionEnabled(rule.id, e.target.checked))}
                    aria-label={t('clashPanel.excluded.toggleAriaLabel', { action: t(rule.enabled ? 'clashPanel.action.disable' : 'clashPanel.action.enable'), label: rule.label })}
                    className="h-3 w-3 shrink-0 accent-primary"
                  />
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground">{t(EXCLUSION_KIND_LABEL_KEY[rule.kind])}</span>
                  <span className={cn('truncate', !rule.enabled && 'text-muted-foreground line-through')}>{rule.label}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {rule.enabled ? t('clashPanel.excluded.countHidden', { count: n }) : t('clashPanel.excluded.countWouldHide', { count: n })}
                  </span>
                  <button
                    onClick={() => applyExclusion(() => removeExclusion(rule.id))}
                    aria-label={t('clashPanel.excluded.removeAriaLabel', { label: rule.label })}
                    title={t('clashPanel.excluded.removeTooltip')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Results — virtualized so 10k+ clashes stay smooth (#1277). */}
      <div ref={scrollRef} className={cn('flex-1 overflow-auto min-h-0', stale && 'opacity-60')} {...tourAnchor(TOUR_ANCHORS.clashResults)}>
        {!result && !running && (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center text-muted-foreground">
            <Crosshair className="h-8 w-8 mb-3 opacity-40" />
            <p className="text-sm">
              {modelCount <= 1
                ? t('clashPanel.empty.singleModelHint')
                : t('clashPanel.empty.multiModelHint')}
            </p>
            <p className="mt-2 text-2xs">{t('clashPanel.empty.hint')}</p>
          </div>
        )}

        {result && total === 0 && coverageOutcome === 'no-match' && isMultiRuleRun && (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <AlertTriangle className="h-6 w-6 mb-2 text-[#e0af68]" />
            <p className="text-sm font-medium">{t('clashPanel.matrixNoMatch.title')}</p>
            <p className="mt-1.5 text-xs text-muted-foreground max-w-xs">{t('clashPanel.matrixNoMatch.description', { count: result.rulesRun.length })}</p>
            <p className="mt-1.5 text-2xs text-muted-foreground max-w-xs">{t('clashPanel.matrixNoMatch.emptyRules', { names: emptyRuleNames.join(', ') })}</p>
          </div>
        )}

        {result && total === 0 && coverageOutcome === 'no-match' && !isMultiRuleRun && (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <AlertTriangle className="h-6 w-6 mb-2 text-[#e0af68]" />
            <p className="text-sm font-medium">{t('clashPanel.selectorNoMatch.title')}</p>
            <p className="mt-1.5 text-xs text-muted-foreground max-w-xs">
              {t('clashPanel.selectorNoMatch.description', { reasons: emptySelectorDescriptions.join(', ') })}
            </p>
          </div>
        )}

        {result && total === 0 && coverageOutcome !== 'no-match' && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
            <p className="text-sm">{t('clashPanel.noClashes.title')}</p>
            {coverageOutcome === 'partial' && emptyRuleNames.length > 0 && (
              <p className="mt-1.5 text-2xs max-w-xs">
                {t('clashPanel.noClashes.partialRules', { count: emptyRuleNames.length, names: emptyRuleNames.join(', ') })}
              </p>
            )}
          </div>
        )}

        {result && total > 0 && shown === 0 && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
            <p className="text-sm">{t('clashPanel.noMatches.title')}</p>
            <p className="mt-1 text-2xs">
              {hideTouching && touchingCount > 0 ? t('clashPanel.noMatches.hintWithUntick') : t('clashPanel.noMatches.hintPlain')}
            </p>
          </div>
        )}

        {displayRows.length > 0 && (
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((v) => {
              const row = displayRows[v.index];
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={rowVirtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                >
                  {row.kind === 'group' ? (
                    <ClashGroupHeaderWithActions
                      section={row}
                      collapsed={collapsed.has(row.key)}
                      creatingTopic={creatingTopic}
                      focusMode={focusMode} membersById={manualMembersById}
                      onToggle={toggleSection}
                      onFocus={focusClashes}
                      onAddToGroup={openAddToGroup}
                      onCreateBcf={(groupId) => { void createBcfTopicForGroup(groupId); }}
                      onRename={(groupId, label) => setGroupDialog({ mode: 'rename', groupId, initialName: label })}
                      onRemove={removeManualGroup}
                      showGroups={showManualGroups}
                    />
                  ) : row.kind === 'detail' ? (
                    <div className="border-t border-border/40 pb-1.5">
                      <div className="px-7 py-1 text-2xs text-muted-foreground">{describeClash(row.clash)}</div>
                      <ElementRow el={row.clash.a} side={0} />
                      <ElementRow el={row.clash.b} side={1} />
                      <ClashExclusionActions
                        clash={row.clash}
                        typeAnyCountOf={(tag) => typeAnyCounts.get(tag) ?? 0}
                        typePairCount={typePairCount(row.clash)}
                        onExcludeTypeAny={(tag) => applyExclusion(() => excludeTypeAny(tag))}
                        onExcludeTypePair={() => applyExclusion(() => excludeTypePair(row.clash))}
                        onExcludeElementPair={() => applyExclusion(() => excludeElementPair(row.clash))}
                      />
                      <ClashReviewControls
                        status={reviewOf(row.clash)}
                        comment={reviewCommentOf(row.clash)}
                        onStatus={(s) => applyReview(row.clash, { status: s })}
                        onComment={(text) => applyReview(row.clash, { comment: text })}
                      />
                    </div>
                  ) : (
                    <div className={cn('flex w-full items-stretch border-t border-border/40 text-xs', selectedId === row.clash.id && 'bg-primary/10')}>
                      <ClashGroupingCheckbox
                        clash={row.clash}
                        checked={checkedClashIds.has(row.clash.id)}
                        onChange={(checked) => setCheckedClashIds((previous) => {
                            const next = new Set(previous);
                            if (checked) next.add(row.clash.id);
                            else next.delete(row.clash.id);
                            return next;
                        })}
                      />
                      <button
                        onClick={() => toggleExpand(row.clash.id)}
                        aria-expanded={expanded.has(row.clash.id)}
                        title={expanded.has(row.clash.id) ? t('clashPanel.rowCollapseTooltip') : t('clashPanel.rowShowBothTooltip')}
                        className="flex items-center pl-2 pr-1 text-muted-foreground hover:text-foreground"
                      >
                        {expanded.has(row.clash.id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => focusClash(row.clash, focusMode)}
                        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left hover:bg-muted/50"
                      >
                        <span className="self-stretch w-0.5 rounded-full shrink-0" style={{ background: SEVERITY[row.clash.severity].color }} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">
                            <span className="text-foreground">{row.clash.a.tag}</span>
                            <span className="text-muted-foreground"> × </span>
                            <span className="text-foreground">{row.clash.b.tag}</span>
                            {isTouching(row.clash) && (
                              <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground">{t('clashPanel.touchBadge')}</span>
                            )}
                          </div>
                          <div className="truncate text-2xs text-muted-foreground">
                            {row.clash.a.name ?? shortName(row.clash.a.key)} ↔ {row.clash.b.name ?? shortName(row.clash.b.key)}
                          </div>
                        </div>
                        {(() => {
                          const rs = reviewOf(row.clash);
                          const hasComment = reviewCommentOf(row.clash).length > 0;
                          return (
                            <>
                              {rs !== 'open' && (
                                <span
                                  className="shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium"
                                  style={{ background: `${REVIEW_STATUS[rs].color}1f`, color: REVIEW_STATUS[rs].color }}
                                >
                                  {t(REVIEW_STATUS[rs].labelKey)}
                                </span>
                              )}
                              {hasComment && (
                                <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('clashPanel.hasCommentAriaLabel')} />
                              )}
                            </>
                          );
                        })()}
                        <span className="shrink-0 tabular-nums text-muted-foreground">{formatDistance(row.clash.distance)}</span>
                      </button>
                      <button
                        onClick={() => focusClash(row.clash, focusMode === 'highlight' ? 'isolate' : focusMode)}
                        title={focusMode === 'ghost' ? t('clashPanel.focusToggleGhostTooltip') : t('clashPanel.focusToggleIsolateTooltip')}
                        className="flex items-center px-2 text-muted-foreground hover:text-foreground"
                      >
                        <Focus className="h-3.5 w-3.5" />
                      </button>
                      {row.manualGroupId && (
                        <RemoveFromClashGroupButton onClick={() => removeManualGroupMember(row.manualGroupId!, row.clash)} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <ClashManualGroupDialog
        open={groupDialog !== null}
        initialName={dialogProps.initialName}
        memberCount={dialogProps.memberCount}
        mode={groupDialog?.mode ?? 'create'}
        onOpenChange={(open) => { if (!open) setGroupDialog(null); }}
        onSubmit={submitGroupDialog}
      />
    </div>
  );
}
