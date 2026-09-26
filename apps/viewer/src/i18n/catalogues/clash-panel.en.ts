/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Clash Detection panel's own chrome (#4918 slice: viewer-panels).
 * Covers `ClashPanel.tsx`: the header and its help disclosure, the
 * detection controls (mode/tol/gap, the run buttons, live progress), the
 * result summary toolbar (group-by/sort, filters, on-select focus, bulk
 * actions), the on-demand intersection-solid status line, the user's
 * exclusion list, every empty/no-match/no-comparison state, and the
 * per-row exclusion and review-comment controls (`ClashExclusionActions`,
 * `ExcludeAnyButton`, `ClashReviewControls`).
 *
 * Out of scope, deliberately: `describeClash()`'s plain-language finding
 * description is reused verbatim as a BCF topic's persisted description
 * (`createBcfTopic`) — it is exported CONTENT, not pure view chrome, and
 * translating only the on-screen call site while the BCF-exported copy
 * stayed English would produce a sentence that reads in two languages
 * depending on where it landed. The same reasoning keeps the BCF topic
 * `title`/`description` strings and the `'Clash report'` project name in
 * `createBcfTopic` untranslated. IFC class tags (`clash.a.tag` and
 * friends) are model content throughout.
 */
export const clashPanelEn = {
  'clashPanel.title': 'Clash detection',
  'clashPanel.helpTooltip': 'How clash detection works',
  'clashPanel.clearResultsTooltip': 'Clear results',
  'clashPanel.closeTooltip': 'Close',

  // Help disclosure (#1272, #1274)
  'clashPanel.help.hardLabel': 'Hard',
  'clashPanel.help.hardDescription': 'finds interpenetrations (overlap beyond',
  'clashPanel.help.tolAbbrev': 'tol',
  'clashPanel.help.clearanceLabel': 'Clearance',
  'clashPanel.help.clearanceDescription': 'additionally flags elements closer than the required',
  'clashPanel.help.gapAbbrev': 'gap',
  'clashPanel.help.gapAddsMore': '— so raising the gap adds',
  'clashPanel.help.moreLabel': 'more',
  'clashPanel.help.resultsNotFiltered': 'results, it does not filter existing ones.',
  'clashPanel.help.tolDescription': 'is the touch band (m) — how much bare surface contact is ignored.',
  'clashPanel.help.gapDescription': '(clearance mode) is the minimum required separation.',
  'clashPanel.help.severityLabel': 'Severity',
  'clashPanel.help.severityDescription': 'comes from the element-type pair (e.g. pipe vs structure = critical),',
  'clashPanel.help.notLabel': 'not',
  'clashPanel.help.fromOverlapDepth': 'from overlap depth. Sort by',
  'clashPanel.help.overlapDepthLabel': 'overlap depth',
  'clashPanel.help.surfaceWorst': 'to surface the worst interpenetrations first.',
  'clashPanel.help.touchingLabel': 'Touching',
  'clashPanel.help.touchingDescription':
    'results sit at ≈0 m — coincident faces such as a wall meeting a slab. Hide them to focus on genuine overlaps.',

  // Detection controls
  'clashPanel.detectionSectionLabel': 'Detection',
  'clashPanel.rerunTooltip': 'Re-run detection on the whole model',
  'clashPanel.rerunTooltipMatrix': 'Re-run the enabled rule set',
  'clashPanel.rerunTooltipPreset': 'Re-run rule "{name}"',
  'clashPanel.rerunTooltipDuplicates': 'Re-run the duplicate scan',
  'clashPanel.rerun': 'Re-run',
  'clashPanel.cancel': 'Cancel detection',
  'clashPanel.tolLabelTooltip': 'Touch band (m): surface contact within this distance is ignored',
  'clashPanel.gapLabelTooltip': 'Minimum required separation (m); elements closer than this are flagged',
  'clashPanel.detectAll': 'Detect all clashes',
  'clashPanel.findDuplicatesTooltip': 'Find duplicate or fully-overlapping objects in the loaded geometry',
  'clashPanel.findDuplicates': 'Find duplicates',
  'clashPanel.disciplineMatrixTooltip': 'Run the enabled discipline-vs-discipline rules',
  'clashPanel.disciplineMatrix': 'Discipline matrix',
  'clashPanel.progress.checking': 'Checking {done} / {total} pairs',
  'clashPanel.progress.preparing': 'Preparing geometry…',

  // Result summary toolbar
  'clashPanel.clusterRadiusTooltip': 'Spatial cluster radius: {epsilon}m (Clash settings)',
  'clashPanel.groupedByProximity': 'Grouped by proximity',
  'clashPanel.userDefinedGroups': 'User-defined groups',
  'clashPanel.duplicateScanGroupTooltip': 'Duplicate scans always group by coincident set',
  'clashPanel.groupBySeverityOption': 'By severity',
  'clashPanel.groupByRuleOption': 'By rule',
  'clashPanel.groupByTypePairOption': 'By type pair',
  'clashPanel.sort.severity': 'Sort: severity',
  'clashPanel.sort.depth': 'Sort: overlap depth',
  'clashPanel.sort.distance': 'Sort: distance',
  'clashPanel.groupSelectedTooltip': 'Select at least two clash rows, then create one named group',
  'clashPanel.groupSelectedButton': 'Group selected',
  'clashPanel.hideTouchingTooltip': 'Hide ≈0 m face/edge contacts',
  'clashPanel.hideTouchingLabel': 'Hide touching',
  'clashPanel.severity.critical': 'Critical',
  'clashPanel.severity.major': 'Major',
  'clashPanel.severity.minor': 'Minor',
  'clashPanel.severity.info': 'Info',
  'clashPanel.reviewStatus.open': 'Open',
  'clashPanel.reviewStatus.resolved': 'Resolved',
  'clashPanel.reviewStatus.accepted': 'Accepted',
  'clashPanel.action.hide': 'Hide',
  'clashPanel.action.show': 'Show',
  'clashPanel.statusFilterTooltip': '{action} {status} clashes',
  'clashPanel.focusModeTooltip': 'How the rest of the model is shown when you click a clash',
  'clashPanel.onSelectLabel': 'On select:',
  'clashPanel.focusMode.highlightLabel': 'Highlight',
  'clashPanel.focusMode.highlightTooltip': 'Keep the whole model visible',
  'clashPanel.focusMode.isolateLabel': 'Isolate',
  'clashPanel.focusMode.isolateTooltip': 'Hide everything except the clashing pair',
  'clashPanel.focusMode.ghostLabel': 'Ghost',
  'clashPanel.focusMode.ghostTooltip': 'Fade the rest to translucent context (X-Ray)',
  'clashPanel.highlightAllTooltip': 'Select every element involved in a clash',
  'clashPanel.highlightAllButton': 'Highlight all',
  'clashPanel.clearHighlightTooltip': 'Clear selection, isolation and ghosting',
  'clashPanel.clearButton': 'Clear',

  // On-demand intersection solid (#clash-solid)
  'clashPanel.solid.computing': 'Computing the true overlap volume…',
  'clashPanel.solid.shown':
    'True overlap volume shown as a solid: {volume}. Both elements are ghosted so it reads through them.',
  'clashPanel.solid.belowResolution':
    'No solid — this overlap is thinner ({thickness} mm) than the kernel can resolve as a volume (needs ≥ {required} mm); showing the contact marker instead.',
  'clashPanel.solid.noOverlap':
    'No solid — the surfaces touch without a measurable penetration; showing the contact marker instead.',
  'clashPanel.solid.emptyOperand': "No solid — one side's geometry isn't available yet; showing the contact marker instead.",
  'clashPanel.solid.unknown': 'No solid could be computed for this pair; showing the contact marker instead.',

  // The user's own exclusions
  'clashPanel.excluded.header': 'Excluded',
  'clashPanel.excluded.summary': { one: '{count} rule', other: '{count} rules' },
  'clashPanel.excluded.hiddenSuffix': { one: ' · {count} hidden', other: ' · {count} hidden' },
  'clashPanel.excluded.clearAllTooltip': 'Remove every exclusion and show all clashes again',
  'clashPanel.excluded.clearAllButton': 'Clear all',
  'clashPanel.excluded.kindAny': 'any',
  'clashPanel.excluded.kindType': 'type',
  'clashPanel.excluded.kindPair': 'pair',
  'clashPanel.action.disable': 'Disable',
  'clashPanel.action.enable': 'Enable',
  'clashPanel.excluded.toggleAriaLabel': '{action} exclusion {label}',
  'clashPanel.excluded.countHidden': { one: '{count} hidden', other: '{count} hidden' },
  'clashPanel.excluded.countWouldHide': { one: '{count} would hide', other: '{count} would hide' },
  'clashPanel.excluded.removeAriaLabel': 'Remove exclusion {label}',
  'clashPanel.excluded.removeTooltip': 'Remove this exclusion',

  // Per-row exclusion actions (#1276/#2536)
  'clashPanel.exclude.header': 'Overlap by design?',
  'clashPanel.exclude.anyTagTooltip': 'Stop reporting {tag} against anything at all',
  'clashPanel.exclude.anyButton': 'Exclude anything touching {tag}',
  'clashPanel.exclude.pairTooltip': 'Stop reporting any {tagA} against any {tagB}',
  'clashPanel.exclude.pairButton': 'Exclude all {tagA} × {tagB}',
  'clashPanel.exclude.elementTooltip': 'Stop reporting these two elements against each other',
  'clashPanel.exclude.elementButton': 'Exclude just this pair',

  // Per-row review controls (#1468)
  'clashPanel.review.label': 'Review',
  'clashPanel.review.commentPlaceholder': 'Add a comment (optional)',

  // Empty / no-match / no-comparison states
  'clashPanel.empty.singleModelHint':
    'Check this model in seconds: “Detect all clashes” finds every overlap inside it, and “Find duplicates” catches coincident objects — no discipline setup needed.',
  'clashPanel.empty.multiModelHint':
    'Detect all clashes, run the discipline matrix, or pick a preset to find conflicts across the loaded models.',
  'clashPanel.empty.hint': 'Click any result to highlight both elements; expand a row to step through each object.',
  'clashPanel.matrixNoMatch.title': "The matrix didn't apply to this model — it did NOT run.",
  'clashPanel.matrixNoMatch.description':
    'None of the {count} rule(s) matched any elements here, so "0 clashes" doesn\'t mean this model is clean — nothing was actually checked. This rule set is shaped for MEP/HVAC/electrical/fire coordination; it may not describe this model\'s disciplines.',
  'clashPanel.matrixNoMatch.emptyRules': 'Empty rules: {names}',
  'clashPanel.selectorNoMatch.title': 'No comparison ran — a selector matched nothing.',
  'clashPanel.selectorNoMatch.description':
    '"0 clashes" doesn\'t mean this model is clean — {reasons}, so this rule never compared a single pair.',
  'clashPanel.noClashes.title': 'No clashes found for this rule set. 🎉',
  'clashPanel.noClashes.partialRules': '{count} rule(s) matched no elements and never ran: {names}',
  'clashPanel.noMatches.title': 'No clashes match the current filters.',
  'clashPanel.noMatches.hintPlain': 'Adjust the status filter above.',
  'clashPanel.noMatches.hintWithUntick': 'Adjust the status filter or untick "Hide touching" above.',

  // Result rows
  'clashPanel.rowCollapseTooltip': 'Collapse',
  'clashPanel.rowShowBothTooltip': 'Show both objects',
  'clashPanel.touchBadge': 'touch',
  'clashPanel.hasCommentAriaLabel': 'Has a review comment',
  'clashPanel.focusToggleGhostTooltip': 'Ghost the rest (X-Ray context)',
  'clashPanel.focusToggleIsolateTooltip': 'Isolate this pair (hide everything else)',
} as const;
