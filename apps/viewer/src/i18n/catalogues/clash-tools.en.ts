/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The clash-detection tool surfaces the clash-panel/clash-groups slices
 * left uncovered (#4918 slice: clashrest), each its own dialog or control
 * cluster reached from `ClashPanel.tsx` rather than that file itself:
 * `ClashExportActions.tsx` (the export button cluster), `ClashBcfExportDialog.tsx`
 * (the "Export to BCF" grouping/severity/snapshot dialog), `ClashModelTagNotice.tsx`
 * (the stale-tags banner), `ClashRevisionCompareDialog.tsx` (baseline save +
 * compare-across-revisions), `ClashRuleDraftEditor.tsx` and
 * `ClashSetFilterEditor.tsx` (the add/edit-rule form and its per-side advanced
 * filter), and `ClashSettingsDialog.tsx` (the Detection/Rules settings dialog).
 *
 * Severity labels (`Critical`/`Major`/`Minor`/`Info`) reuse the existing
 * `clashPanel.severity.*` keys rather than duplicating them here — both
 * `ClashBcfExportDialog.tsx`'s `SEVERITIES` table and `ClashSettingsDialog.tsx`'s
 * `SEVERITY` table carry a `labelKey` pointing at those keys, same
 * data-table-plus-`labelKey` pattern `clashPanel.en.ts`'s own `SEVERITY`/
 * `REVIEW_STATUS` tables use.
 *
 * IFC class-selector examples (`IfcWall`, `*`) and single, unadorned IFC
 * EXPRESS names stay literal per the house rule; a composite pattern like
 * `IfcPipe*` or `IfcWall|IfcSlab` is catalogued (its own key) purely so the
 * gate treats it consistently — translators are expected to leave those
 * values unchanged, same as any other selector syntax example.
 */
export const clashToolsEn = {
  // ClashExportActions.tsx
  'clashTools.export.noResultsToast': 'No clash results to export',
  'clashTools.export.csvSuccessToast': {
    one: 'Exported {count} clash to {filename}',
    other: 'Exported {count} clashes to {filename}',
  },
  'clashTools.export.bcfTopicTooltipSelected': 'Create a BCF topic from the selected clash',
  'clashTools.export.bcfTopicTooltipAll': 'Create a BCF topic for this clash report',
  'clashTools.export.bcfTopicButton': 'BCF topic',
  'clashTools.bcfTopic.created': 'Topic created',
  'clashTools.bcfTopic.open': 'Open BCF',
  'clashTools.export.csvTooltip':
    "Download every clash in this run as a CSV table — one row per clash with both GlobalIds, review status and storey — for Excel / Power BI",

  // ClashModelTagNotice.tsx
  'clashTools.modelTagNotice.message':
    'Model tags changed since this run. Its sets were resolved from the tags at the time; run again to use the current ones.',

  // ClashBcfExportDialog.tsx
  'clashTools.bcfExport.dialogTitle': 'Export to BCF',
  'clashTools.bcfExport.dialogDescription':
    'Turn clashes into a manageable set of BCF topics. Control how they group, which to include, and whether to embed snapshots.',
  'clashTools.bcfExport.groupByLabel': 'Group into topics by',
  'clashTools.bcfExport.groupCluster': 'Spatial cluster',
  'clashTools.bcfExport.groupClusterHint':
    'Nearby clashes of the same kind merge into one topic — the sensible default.',
  'clashTools.bcfExport.groupRule': 'Discipline rule',
  'clashTools.bcfExport.groupRuleHint': 'One topic per rule (MEP × Structure, HVAC × Architecture, …).',
  'clashTools.bcfExport.groupTypePair': 'Element-type pair',
  'clashTools.bcfExport.groupTypePairHint': 'One topic per type pair (IfcDuct × IfcWall, …).',
  'clashTools.bcfExport.groupElement': 'Affected element',
  'clashTools.bcfExport.groupElementHint': "One topic per element — all of an element's clashes in one place.",
  'clashTools.bcfExport.severitiesLabel': 'Include severities',
  'clashTools.bcfExport.clashesLabel': 'clashes',
  'clashTools.bcfExport.topicsLabel': { one: 'topic', other: 'topics' },
  'clashTools.bcfExport.maxTopicsLabel': 'Max topics',
  'clashTools.bcfExport.topicStatusNote':
    "Topic status follows each clash's review status: Open stays Open, Resolved and Accepted export as Closed.",
  'clashTools.bcfExport.includeSnapshotsLabel': 'Include snapshots',
  'clashTools.bcfExport.snapshotsHint':
    "Render each topic's viewpoint and embed a PNG. Slower for many topics.",
  'clashTools.bcfExport.capturingSnapshotsProgress': 'Capturing snapshots {done}/{total}…',
  'clashTools.bcfExport.cancelButton': 'Cancel',
  'clashTools.bcfExport.exportingLabel': 'Exporting…',
  'clashTools.bcfExport.exportButton': { one: 'Export {count} topic', other: 'Export {count} topics' },
  'clashTools.bcfExport.exportSuccessToast': { one: 'Exported {count} BCF topic', other: 'Exported {count} BCF topics' },
  'clashTools.bcfExport.exportFailedToast': 'BCF export failed: {reason}',

  // ClashRevisionCompareDialog.tsx
  'clashTools.revisionCompare.triggerTooltip': 'Compare clash runs across revisions',
  'clashTools.revisionCompare.dialogTitle': 'Compare clash runs',
  'clashTools.revisionCompare.dialogDescription':
    'Save the current result as a baseline, then compare it against a later run — new, persisting, and no-longer-detected clashes.',
  'clashTools.revisionCompare.baselineSavedAt': 'Baseline saved {when}',
  'clashTools.revisionCompare.clashCount': { one: '{count} clash', other: '{count} clashes' },
  'clashTools.revisionCompare.baselineSavedToast': {
    one: 'Saved baseline ({count} clash).',
    other: 'Saved baseline ({count} clashes).',
  },
  'clashTools.revisionCompare.noBaseline': 'No baseline saved yet.',
  'clashTools.revisionCompare.saveBaselineTooltip': 'Save the current result as the baseline',
  'clashTools.revisionCompare.runDetectionFirstTooltip': 'Run clash detection first',
  'clashTools.revisionCompare.saveBaselineButton': 'Save current as baseline',
  'clashTools.revisionCompare.saveBaselineFirstTooltip': 'Save a baseline first',
  'clashTools.revisionCompare.compareButton': 'Compare current result to baseline',
  'clashTools.revisionCompare.unretestedCount': {
    one: '{count} clash could not be confirmed as fixed:',
    other: '{count} clashes could not be confirmed as fixed:',
  },
  'clashTools.revisionCompare.newBucketTitle': 'New',
  'clashTools.revisionCompare.persistingBucketTitle': 'Persisting',
  'clashTools.revisionCompare.resolvedBucketTitle': 'No longer detected',
  'clashTools.revisionCompare.unretestedBucketTitle': 'Unconfirmed (not re-tested)',
  'clashTools.revisionCompare.noDifferences': 'No differences.',
  'clashTools.revisionCompare.skippedRules': 'Not re-run this time: {ids}.',
  'clashTools.revisionCompare.noMatchRules': 'Matched no elements this run: {ids}.',
  'clashTools.revisionCompare.missingModels': 'Model(s) no longer in the comparison: {names}.',
  'clashTools.revisionCompare.unretestedGeneric':
    'One or more elements a clash depended on were not matched by the same rule this run (a narrowed selector or membership change) — it can no longer be confirmed as fixed.',

  // ClashRuleDraftEditor.tsx
  'clashTools.ruleEditor.editTitle': 'Edit rule',
  'clashTools.ruleEditor.newTitle': 'New rule',
  'clashTools.ruleEditor.cancelTooltip': 'Cancel',
  'clashTools.ruleEditor.namePlaceholder': 'Rule name (e.g. Ducts vs Beams)',
  'clashTools.ruleEditor.selectorAPlaceholder': 'IfcDuct*|IfcPipe*',
  'clashTools.ruleEditor.selectorBPlaceholder': 'IfcWall*|IfcSlab',
  'clashTools.ruleEditor.saveButton': 'Save',
  'clashTools.ruleEditor.addButton': 'Add',
  'clashTools.ruleEditor.selectorsIntro': 'Selectors:',
  'clashTools.ruleEditor.selectorExamplePipe': 'IfcPipe*',
  'clashTools.ruleEditor.selectorExampleWallSlab': 'IfcWall|IfcSlab',
  'clashTools.ruleEditor.selectorExampleNotSpace': '!IfcSpace',
  'clashTools.ruleEditor.selectorsHelp':
    'Leave B equal to A for a self-clash within one group. Give a side filter rules instead to select it by property, attribute, storey or quantity — its selector is then unnecessary and can be left empty.',
  'clashTools.ruleEditor.loadModelHint': 'load a model to preview',
  'clashTools.ruleEditor.matchCount': { one: '✓ matches {count} class', other: '✓ matches {count} classes' },
  'clashTools.ruleEditor.noMatches': 'matches no classes',

  // ClashSetFilterEditor.tsx
  'clashTools.setFilter.clearTooltip': 'Remove every rule and go back to the type selector',
  'clashTools.setFilter.clearLabel': 'Clear',
  'clashTools.setFilter.unreadableWarning': {
    one:
      'One rule in this filter cannot be read by this version (saved by a newer version, or malformed). Runs using it are refused; any edit here discards that rule.',
    other:
      '{count} rules in this filter cannot be read by this version (saved by a newer version, or malformed). Runs using it are refused; any edit here discards those rules.',
  },
  'clashTools.setFilter.definedByFilter':
    'This filter defines {label}; its type selector above is ignored while it has rules.',

  // ClashSettingsDialog.tsx
  'clashTools.settings.title': 'Clash settings',
  'clashTools.settings.summary': 'Tune detection and curate the rule set. {enabled} of {total} rules enabled.',
  'clashTools.settings.detectionTab': 'Detection',
  'clashTools.settings.rulesTab': 'Rules',
  'clashTools.settings.modeLabel': 'Default mode',
  'clashTools.settings.modeHint':
    'Hard finds interpenetrations; clearance finds gaps smaller than the required distance.',
  'clashTools.settings.toleranceLabel': 'Tolerance',
  'clashTools.settings.toleranceHint':
    'Touching band (m). Surfaces within this distance count as contact, not penetration.',
  'clashTools.settings.clearanceGapLabel': 'Clearance gap',
  'clashTools.settings.clearanceGapHint':
    'Required gap (m) in clearance mode. Anything closer than this is a violation.',
  'clashTools.settings.duplicateToleranceLabel': 'Duplicate tolerance',
  'clashTools.settings.duplicateToleranceHint':
    "How far apart (m) two elements may be and still count as the same object in the duplicate scan. Capped by each element's own thickness: a 2 mm plate gets 2 mm across its thickness, not the full value.",
  'clashTools.settings.clusterRadiusLabel': 'Cluster radius',
  'clashTools.settings.clusterRadiusHint':
    'How far apart clashes can be and still merge into one BCF topic (m).',
  'clashTools.settings.reportTouchLabel': 'Report grazing contacts',
  'clashTools.settings.reportTouchHint':
    'Include touch-classified results (surfaces that just graze) in detection.',
  'clashTools.settings.showRegionBoxLabel': 'Show clash region box',
  'clashTools.settings.showRegionBoxHint':
    "Draw a tight wireframe box around the focused clash's contact region to mark the penetration. On by default; turn off to hide it.",
  'clashTools.settings.groupingLabel': 'Default grouping',
  'clashTools.settings.groupingHint': 'How the results list is organized in the panel.',
  'clashTools.settings.modeHard': 'Hard',
  'clashTools.settings.modeClearance': 'Clearance',
  'clashTools.settings.groupBySeverity': 'By severity',
  'clashTools.settings.groupByRule': 'By rule',
  'clashTools.settings.groupByTypePair': 'By type pair',
  'clashTools.settings.resetDetectionButton': 'Reset detection settings',
  'clashTools.settings.addRuleButton': 'Add rule',
  'clashTools.settings.resetRulesTooltip': 'Reset to the built-in rules',
  'clashTools.settings.exportRulesTooltip': 'Export rules',
  'clashTools.settings.importRulesTooltip': 'Import rules',
  'clashTools.settings.customBadge': 'custom',
  'clashTools.settings.editTooltip': 'Edit',
  'clashTools.settings.deleteTooltip': 'Delete',
  'clashTools.settings.noValidRulesToast': 'No valid rules found in that file.',
  'clashTools.settings.importedRulesToast': { one: 'Imported {count} rule', other: 'Imported {count} rules' },
  'clashTools.settings.importReadErrorToast': 'Could not read that file as clash rules.',
} as const;
