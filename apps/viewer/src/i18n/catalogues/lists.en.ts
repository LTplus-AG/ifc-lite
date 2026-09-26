/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Lists feature (#4918 slice): the list builder (query definition),
 * the saved-list library, the results table and its grouping/schedule
 * chrome, the per-column header menu, the model/tag scope editor, and the
 * error banner. Covers `apps/viewer/src/components/viewer/lists/**`.
 */
export const listsEn = {
  // ColumnHeaderMenu
  'lists.columnMenu.optionsAriaLabel': 'Column options',
  'lists.columnMenu.sortAscending': 'Sort ascending',
  'lists.columnMenu.sortDescending': 'Sort descending',
  'lists.columnMenu.removeFromGrouping': 'Remove from grouping',
  'lists.columnMenu.addGroupingLevel': 'Add grouping level',
  'lists.columnMenu.groupByThisColumn': 'Group by this column',
  'lists.columnMenu.sumThisColumn': 'Sum / total this column',
  'lists.columnMenu.sumNumericOnly': 'Sum (numeric only)',
  'lists.columnMenu.colourByThisColumn': 'Colour by this column',

  // ListErrorBox
  'lists.errorBox.listFailed': 'List failed',
  'lists.errorBox.dismissAriaLabel': 'Dismiss error',

  // ListGroupingBar
  'lists.groupingBar.remove': 'Remove',
  'lists.groupingBar.switchToNestedAriaLabel': 'Switch to nested tree view',
  'lists.groupingBar.switchToScheduleAriaLabel': 'Switch to schedule (pivot) table view',
  'lists.groupingBar.showingScheduleTooltip': 'Showing schedule (pivot) table — switch to nested tree',
  'lists.groupingBar.showingNestedTooltip': 'Showing nested tree — switch to schedule (pivot) table',
  'lists.groupingBar.collapseAllGroups': 'Collapse all groups',
  'lists.groupingBar.expandAllGroups': 'Expand all groups',
  'lists.groupingBar.removeGroupingByAriaLabel': 'Remove grouping by {label}',
  'lists.groupingBar.groupedByChip': 'Grouped by {label}',
  'lists.groupingBar.thenChip': 'then {label}',
  'lists.groupingBar.noGrouping': "No grouping — use a column's {menu} menu to group or sum",
  'lists.groupingBar.removeSumOfAriaLabel': 'Remove sum of {label}',
  'lists.groupingBar.groupCount': { one: '{countDisplay} group', other: '{countDisplay} groups' },
  'lists.groupingBar.elementCount': { one: '{countDisplay} element', other: '{countDisplay} elements' },

  // ListModelTagScopeEditor
  'lists.modelTagScope.models': 'Models',
  'lists.modelTagScope.selectAriaLabel': 'Model tag scope',
  'lists.modelTagScope.allModels': 'all models',
  'lists.modelTagScope.pickAtLeastOneTag': 'Pick at least one tag, or the list runs over no model.',
  // Same four operator words as the advanced filter's OP_LABEL (kept as a
  // local copy rather than importing that shared map — #4918 review, PR
  // #5004: OP_LABEL is a plain untranslated Record consumed by unrelated
  // search-modal editors too, and localizing it here is scoped to what
  // this editor renders, not a cross-cutting rename of a shared module).
  'lists.modelTagScope.opHasAny': 'has any of',
  'lists.modelTagScope.opHasAll': 'has all of',
  'lists.modelTagScope.opHasNone': 'has none of',
  'lists.modelTagScope.opUntagged': 'is untagged',
  'lists.modelTagScope.unknownTagName': 'unknown tag',
  // One complete message per operator (not "Runs over {description}." with
  // a preformatted English description substituted in) so a locale
  // controls word order/agreement for the whole sentence.
  'lists.modelTagScope.runsOverUntagged': 'Runs over untagged models.',
  'lists.modelTagScope.runsOverHasAny': 'Runs over models that have any of {names}.',
  'lists.modelTagScope.runsOverHasAll': 'Runs over models that have all of {names}.',
  'lists.modelTagScope.runsOverHasNone': 'Runs over models that have none of {names}.',
  'lists.modelTagScope.unresolvedTagsWarning': {
    one: 'A tag in this scope no longer exists. The list will not run until it is removed.',
    other: '{count} tags in this scope no longer exist. The list will not run until they are removed.',
  },

  // ListPanel
  'lists.panel.title': 'Lists',
  'lists.panel.editList': 'Edit List',
  'lists.panel.newList': 'New List',
  'lists.panel.results': 'Results',
  'lists.panel.resultsSummary': { one: '{countDisplay} row, {ms}ms', other: '{countDisplay} rows, {ms}ms' },
  'lists.panel.editConfiguration': 'Edit Configuration',
  'lists.panel.backToLists': 'Back to Lists',
  'lists.panel.cancel': 'Cancel',
  'lists.panel.copyName': '{name} (Copy)',

  // ListLibrary
  'lists.library.newList': 'New List',
  'lists.library.import': 'Import',
  'lists.library.savedLists': 'Saved Lists',
  'lists.library.templates': 'Templates',
  'lists.library.run': 'Run',
  'lists.library.runListAriaLabel': 'Run list {name}',
  'lists.library.edit': 'Edit',
  'lists.library.editListAriaLabel': 'Edit list {name}',
  'lists.library.useAsTemplate': 'Use as Template',
  'lists.library.useAsTemplateAriaLabel': 'Use {name} as template',
  'lists.library.duplicate': 'Duplicate',
  'lists.library.duplicateListAriaLabel': 'Duplicate list {name}',
  'lists.library.export': 'Export',
  'lists.library.exportListAriaLabel': 'Export list {name}',
  'lists.library.delete': 'Delete',
  'lists.library.deleteListAriaLabel': 'Delete list {name}',

  // ListScheduleTable
  'lists.scheduleTable.count': 'Count',
  'lists.scheduleTable.countAggregateTitle': 'Count aggregate — the default sort order',
  'lists.scheduleTable.dragToResizeTitle': 'Drag to resize · arrow keys to adjust · Home or double-click to reset',
  'lists.scheduleTable.totalGroups': { one: 'Total · {countDisplay} group', other: 'Total · {countDisplay} groups' },
  'lists.scheduleTable.sumIcon': 'Σ',

  // ListResultsTable
  'lists.resultsTable.defaultTitle': 'List',
  'lists.resultsTable.filterPlaceholder': 'Filter results...',
  'lists.resultsTable.noRows': 'No matching rows',
  'lists.resultsTable.rowCount': { one: '{countDisplay} row', other: '{countDisplay} rows' },
  'lists.resultsTable.rowCountOfTotal': { one: '{countDisplay} / {total} row', other: '{countDisplay} / {total} rows' },
  'lists.resultsTable.showingVisibleOnly': 'Showing visible objects only',
  'lists.resultsTable.showingAllObjects': 'Showing all objects',
  'lists.resultsTable.exportAriaLabel': 'Export',
  'lists.resultsTable.exportEllipsis': 'Export…',
  'lists.resultsTable.exportFailed': 'Export failed: {message}',
  'lists.resultsTable.groupedAriaLabel': 'grouped',
  'lists.resultsTable.groupingLevelAriaLabel': 'grouping level {level}',
  'lists.resultsTable.dragToResizeTitle': 'Drag to resize · arrow keys to adjust · Home or double-click to reset',
  'lists.resultsTable.totalCount': 'Total · {count}',
  'lists.resultsTable.sumIcon': 'Σ',

  // ListBuilder
  'lists.builder.namePlaceholder': 'List name…',
  'lists.builder.descriptionPlaceholder': 'Description (optional)',
  // Section headings — a custom `label` prop, not one of the AST literals
  // gate's policed attributes (#4918 review, PR #5004): the gate only
  // walks aria-label/title/placeholder/alt, so these stayed hardcoded
  // through the original conversion.
  'lists.builder.sectionScope': 'Scope',
  'lists.builder.sectionFilters': 'Filters',
  'lists.builder.sectionColumns': 'Columns',
  'lists.builder.sectionGroupingTotals': 'Grouping & Totals',
  'lists.builder.scopeAllElementsHint': 'All elements',
  'lists.builder.scopeSnapshotHint': { one: '{countDisplay} element · snapshot', other: '{countDisplay} elements · snapshot' },
  'lists.builder.scopeSelectedElementsHint': { one: '{countDisplay} element', other: '{countDisplay} elements' },
  'lists.builder.filterSnapshotLabel': 'Filter snapshot',
  'lists.builder.filterSnapshotHint': {
    one: "— frozen to the {countDisplay} element that matched the search filter. Entity-type scope doesn't apply; configure columns and grouping below.",
    other: "— frozen to the {countDisplay} elements that matched the search filter. Entity-type scope doesn't apply; configure columns and grouping below.",
  },
  'lists.builder.noTypeSelected': 'No type selected — the list targets all model elements. Use filters to narrow by name, material, classification or storey.',
  'lists.builder.run': 'Run',
  'lists.builder.save': 'Save',
  'lists.builder.cancel': 'Cancel',
  'lists.builder.closeEditorAriaLabel': 'Close editor',
  'lists.builder.editColumnAriaLabel': 'Edit column',
  'lists.builder.moveUpAriaLabel': 'Move up',
  'lists.builder.moveDownAriaLabel': 'Move down',
  'lists.builder.removeColumnAriaLabel': 'Remove column',
  'lists.builder.customColumn': 'Custom column',
  'lists.builder.customColumnHint': 'Pset/Qto or /regex/',
  'lists.builder.property': 'Property',
  'lists.builder.quantity': 'Quantity',
  'lists.builder.regexBadge': 'regex',
  'lists.builder.closeCustomColumnAriaLabel': 'Close custom column',
  'lists.builder.quantitySetPlaceholder': 'Qto_… or /Qto_.*/',
  'lists.builder.propertySetPlaceholder': 'Pset_… or /Pset_.*/',
  'lists.builder.quantityNamePlaceholder': 'NetVolume',
  'lists.builder.propertyNamePlaceholder': 'FireRating',
  'lists.builder.addCustomColumnAriaLabel': 'Add custom column',
  'lists.builder.saveColumnAriaLabel': 'Save column',
  'lists.builder.invalidPatternHint': 'Invalid pattern. It would be matched as a literal name, so it likely hits nothing.',
  'lists.builder.patternHint': 'Type an exact set name, or wrap a pattern in {delimiter} to pull one value across every matching set, e.g. {example}.',
  'lists.builder.patternMatchesNone': 'matches 0 sets in loaded models',
  'lists.builder.patternMatches': { one: 'matches {countDisplay} set: {names}', other: 'matches {countDisplay} sets: {names}' },
  'lists.builder.patternMatchesWithMore': { one: 'matches {countDisplay} set: {names} +{extra} more', other: 'matches {countDisplay} sets: {names} +{extra} more' },
  'lists.builder.added': 'added',
  'lists.builder.groupByLabel': 'Group by',
  'lists.builder.thenByLabel': 'then by',
  'lists.builder.noneFlatList': '— None (flat list) —',
  'lists.builder.none': 'None',
  'lists.builder.groupCountHint': 'Each group shows its element count.',
  'lists.builder.totalsHint': 'Σ Totals — sum these columns per group and overall',
  'lists.builder.sumIcon': 'Σ',
  'lists.builder.addFilter': 'Add filter',
  'lists.builder.filterDimensionAriaLabel': 'Filter dimension',
  'lists.builder.attributeAriaLabel': 'Attribute',
  'lists.builder.spatialLevelAriaLabel': 'Spatial level',
  'lists.builder.zoneSetAriaLabel': 'Zone set',
  'lists.builder.noZoneSets': '(no zone sets)',
  'lists.builder.zoneDisplayModeAriaLabel': 'Zone display mode',
  'lists.builder.zoneOption': 'Zone',
  'lists.builder.straddlesOption': 'Straddles',
  'lists.builder.qtoPlaceholder': 'Qto_…',
  'lists.builder.psetPlaceholder': 'Pset_…',
  'lists.builder.namePropertyPlaceholder': 'name',
  'lists.builder.operatorAriaLabel': 'Operator',
  'lists.builder.removeFilterAriaLabel': 'Remove filter',
  'lists.builder.source.attribute': 'Attribute',
  'lists.builder.source.property': 'Property',
  'lists.builder.source.quantity': 'Quantity',
  'lists.builder.source.material': 'Material',
  'lists.builder.source.classification': 'Classification',
  'lists.builder.source.spatial': 'Spatial',
  'lists.builder.source.model': 'Model',
  'lists.builder.source.zone': 'Zone',
  'lists.builder.operator.contains': 'contains',
  'lists.builder.operator.isSet': 'is set',
  'lists.builder.spatial.container': 'Container',
  'lists.builder.spatial.storey': 'Storey',
  'lists.builder.spatial.building': 'Building',
  'lists.builder.spatial.site': 'Site',
  'lists.builder.spatial.project': 'Project',
  'lists.builder.zoneVolumeOption': 'Volume (mesh)',
  'lists.builder.zoneBreakdownOption': 'Volume breakdown (mesh)',
  'lists.builder.valuePlaceholder.spatial': '{level} name',
  'lists.builder.valuePlaceholder.model': 'model / file',
  'lists.builder.valuePlaceholder.material': 'material',
  'lists.builder.valuePlaceholder.classification': 'code or name',
  'lists.builder.valuePlaceholder.boolean': 'true / false',
  'lists.builder.valuePlaceholder.volume': 'volume',
  'lists.builder.valuePlaceholder.zoneBreakdown': 'zone: value, …',
  'lists.builder.valuePlaceholder.zoneName': 'zone name',
  'lists.builder.valuePlaceholder.value': 'value',
} as const satisfies Record<string, TranslationValue>;
