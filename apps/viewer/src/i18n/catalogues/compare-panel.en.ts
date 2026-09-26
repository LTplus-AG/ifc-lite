/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Compare panel (#924, #4918 compare slice): `ComparePanel.tsx`'s own
 * header/empty-state/BCF-compose-strip chrome and its `compare/` components
 * — the run controls (`CompareRunControls`, `CompareBlacklist`), the results
 * list and its Matched/Suggestions sections (`CompareResultsList`,
 * `CompareMatchGroups`, `CompareSuggestions`), the "what changed" detail
 * (`ChangeDetailView`), the download strip (`CompareExportBar`), and the
 * "raise a BCF topic from this change" affordance (`BcfFromChange`). This is
 * a sibling to the unrelated `compare-key-property.en.ts` (the authored-key
 * picker feature), not the same catalogue under a new name.
 *
 * Element/type NAMES, IFC class tags, and the `bcfTextFromChange` title and
 * description text stay literal: they are either model content or, for the
 * BCF pre-fill, text that is persisted verbatim into an exported BCF topic
 * (same reasoning the BCF-panel and clash-panel catalogues already document
 * for `describeClash()` — translating only the on-screen call site while the
 * exported copy stayed English would read as two languages for one
 * sentence). The `Ignore`-picker's per-class option text (`shortName`) and
 * the results list's per-row change-kind join are IFC class/keyword data,
 * not UI copy.
 */
export const comparePanelEn = {
  // ComparePanel
  'comparePanel.panel.title': 'Compare models',
  'comparePanel.panel.clearResultsTitle': 'Clear results',
  'comparePanel.panel.closeTitle': 'Close',
  'comparePanel.panel.loadSecondModel':
    'Load a second model to compare. Open two IFC files (federation), then pick version A and version B here.',
  'comparePanel.panel.backToChangesTitle': 'Back to changes',
  'comparePanel.panel.topicFor': 'Topic for',
  'comparePanel.panel.countUnchanged': 'Unchanged',

  // Shared across CompareMatchGroups / CompareResultsList / CompareSuggestions
  'comparePanel.moreNotShown': '+{count} more not shown',

  // BcfFromChange
  'comparePanel.bcfFromChange.created': 'BCF topic created: “{title}”',
  'comparePanel.bcfFromChange.openBcf': 'Open BCF',
  'comparePanel.bcfFromChange.createButton': 'Create BCF topic',

  // ChangeDetailView
  'comparePanel.changeDetail.geometryLabel': 'Geometry',
  'comparePanel.changeDetail.dataLabel': 'Data',
  'comparePanel.changeDetail.dataFingerprintOnly':
    'Data fingerprint differs but no field-level change could be pinpointed.',
  'comparePanel.changeDetail.noFieldDetail': 'No field-level detail available.',
  'comparePanel.changeDetail.headlineReshapedMoved': 'Reshaped + moved',
  'comparePanel.changeDetail.headlineReshaped': 'Reshaped',
  'comparePanel.changeDetail.headlineMoved': 'Moved',
  'comparePanel.changeDetail.headlineGeometryChanged': 'Geometry changed',
  'comparePanel.changeDetail.movedLine': '{distance} m (Δx {dx}, Δy {dy}, Δz {dz})',
  'comparePanel.changeDetail.sizeLine': 'size (Δx {dx}, Δy {dy}, Δz {dz}) m',
  'comparePanel.changeDetail.unchangedShapeHash':
    'Shape hash differs but the element’s position and size are unchanged.',

  // CompareBlacklist
  'comparePanel.blacklist.ignoreLabel': 'Ignore',
  'comparePanel.blacklist.pickerTitle': 'Ignore an IFC class - not counted as changes',
  'comparePanel.blacklist.pickerPlaceholder': 'a class...',
  'comparePanel.blacklist.chipTitle': '{type} - ignored',
  'comparePanel.blacklist.removeTitle': 'Stop ignoring {type}',
  'comparePanel.blacklist.clearLabel': 'Clear',
  'comparePanel.blacklist.clearTitle': 'Clear ignored classes',

  // CompareExportBar
  'comparePanel.exportBar.downloadReportLabel': 'Download report',
  'comparePanel.exportBar.identityTooltip':
    'Identity map: the pairs you accepted. Lineage: identity, splits, merges and accepted replacements.',
  'comparePanel.exportBar.identityLabel': 'Identity',
  'comparePanel.exportBar.exportMapButton': 'Export map',
  'comparePanel.exportBar.exportLineageButton': 'Export lineage',
  'comparePanel.exportBar.importMapButton': 'Import map',
  'comparePanel.exportBar.importAriaLabel': 'Import identity map',
  'comparePanel.exportBar.importedPartial':
    'Imported {imported} of {total} entries; {refused} collide with pairs already accepted.',
  'comparePanel.exportBar.importedAll': {
    one: 'Imported {count} identity entry.',
    other: 'Imported {count} identity entries.',
  },

  // CompareMatchGroups
  'comparePanel.matchGroups.matchedLabel': 'Matched',
  'comparePanel.matchGroups.selectAllTitle': 'Select all content-matched elements in 3D',

  // CompareResultsList
  'comparePanel.resultsList.emptyPrompt': 'Run a comparison to see added, changed, and deleted elements.',
  'comparePanel.resultsList.selectAllInDTitle': 'Select all {label} in 3D',
  'comparePanel.resultsList.noDifferences': 'No differences in scope “{scope}”. The models match.',
  'comparePanel.resultsList.stateChanged': 'Changed',
  'comparePanel.resultsList.stateAdded': 'Added',
  'comparePanel.resultsList.stateDeleted': 'Deleted',

  // CompareRunControls
  'comparePanel.runControls.baseLabel': 'A',
  'comparePanel.runControls.headLabel': 'B',
  'comparePanel.runControls.pickDifferentModels': 'Pick two different models.',
  'comparePanel.runControls.scopeBoth': 'Both',
  'comparePanel.runControls.scopeData': 'Data',
  'comparePanel.runControls.scopeGeometry': 'Geometry',
  'comparePanel.runControls.showUnchanged': 'Show unchanged',
  'comparePanel.runControls.matchByContentLabel': 'Match re-exported elements by content',
  'comparePanel.runControls.matchByContentHint':
    'Re-pairs elements whose GlobalId changed but whose content did not.',
  'comparePanel.runControls.runComparison': 'Run comparison',
  'comparePanel.runControls.cancel': 'Cancel comparison',
  'comparePanel.runControls.geometryUnavailablePlacementOnly':
    'Neither model has mesh geometry fingerprints (loaded outside the WASM mesh path), so SHAPE changes can’t be detected. Placement-driven moves and data changes are still compared.',
  'comparePanel.runControls.geometryUnavailableFull':
    'One model has no geometry fingerprints (loaded outside the WASM mesh path), so geometry changes can’t be detected. Data changes are still accurate — switch to the Data scope for reliable results.',

  // CompareSuggestions
  'comparePanel.suggestions.classChangedTitle': 'The IFC class changed on the way',
  'comparePanel.suggestions.classChangedLabel': 'class changed',
  'comparePanel.suggestions.selectAllTitle': 'Select every suggested element in 3D',
  'comparePanel.suggestions.sectionLabel': 'Suggestions',
  'comparePanel.suggestions.candidateAAriaLabel': 'Candidate in A',
  'comparePanel.suggestions.candidateBAriaLabel': 'Candidate in B',
  'comparePanel.suggestions.isConnector': 'is',
  'comparePanel.suggestions.decidedLabel': 'decided',
  'comparePanel.suggestions.acceptButton': 'Accept',
  'comparePanel.suggestions.notSameButton': 'Not the same',
} as const satisfies Record<string, TranslationValue>;
