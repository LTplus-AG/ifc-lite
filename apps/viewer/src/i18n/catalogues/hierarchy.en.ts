/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The spatial hierarchy tree (#4918 slice 4): tree row chrome
 * (`HierarchyNode`, `CountBadgeTooltip`), the Models section (header, tag
 * chips, tag editor, per-row tag strip), the sort control, and the Building
 * Storeys display controls. Row NAMES, TYPE NAMES and TAG NAMES are model
 * content, not literals — only the chrome around them is catalogued here.
 *
 * `hierarchy.panel.*` (#4918 slice: panel outer chrome) extends this same
 * catalogue with `HierarchyPanel.tsx`'s OWN chrome — the panel shell around
 * the tree/node rows above: the loading/no-model empty states, the search
 * placeholder, the grouping-mode tab strip and Groups sub-filter chips, the
 * section headers per grouping mode, the storey/class-filter/type-isolation
 * footer chips and their clear controls, and the resize-divider hint.
 */
export const hierarchyEn = {
  // HierarchyNode: model-header row
  'hierarchy.node.repositionAriaLabel': 'Reposition model {name}',
  'hierarchy.node.repositionTooltip': 'Reposition model',
  'hierarchy.node.hideModelAriaLabel': 'Hide model {name}',
  'hierarchy.node.showModelAriaLabel': 'Show model {name}',
  'hierarchy.node.hideModel': 'Hide model',
  'hierarchy.node.showModel': 'Show model',
  'hierarchy.node.syncModelAriaLabel': 'Sync model {name} from source',
  'hierarchy.node.syncing': 'Syncing model…',
  'hierarchy.node.syncFromSource': 'Sync from source',
  'hierarchy.node.removeModelAriaLabel': 'Remove model {name}',
  'hierarchy.node.removeModel': 'Remove model',
  'hierarchy.removeModelConfirm.title': 'Remove model with unexported changes?',
  'hierarchy.removeModelConfirm.description': {
    one: '{name} has {count} change that has not been exported. Removing the model discards it.',
    other: '{name} has {count} changes that have not been exported. Removing the model discards them.',
  },
  'hierarchy.removeModelConfirm.cancel': 'Cancel',
  'hierarchy.removeModelConfirm.confirm': 'Remove and discard changes',

  // HierarchyNode: regular spatial/element row
  'hierarchy.node.collapseAriaLabel': 'Collapse {name}',
  'hierarchy.node.expandAriaLabel': 'Expand {name}',
  'hierarchy.node.hideAriaLabel': 'Hide {name}',
  'hierarchy.node.showAriaLabel': 'Show {name}',
  'hierarchy.node.hide': 'Hide',
  'hierarchy.node.show': 'Show',
  'hierarchy.node.nameAndSecondaryTitle': '{name} - {secondaryName}',
  'hierarchy.node.elevationTooltip': 'Elevation: {sign}{value}m',
  'hierarchy.node.elevationBadge': '{sign}{value}m',
  'hierarchy.countBadge.elements': { one: '{formatted} element', other: '{formatted} elements' },
  'hierarchy.countBadge.objects': { one: '{formatted} object', other: '{formatted} objects' },
  'hierarchy.countBadge.loadingGeometry': 'geometry still loading — counting every object',
  'hierarchy.countBadge.withoutGeometry': { one: '{formatted} element without geometry', other: '{formatted} elements without geometry' },
  'hierarchy.countBadge.spacesNotCounted': { one: '{formatted} space (not counted)', other: '{formatted} spaces (not counted)' },

  // ModelTagGroupRow
  'hierarchy.modelTagGroup.memberCount': { one: '{formatted} model', other: '{formatted} models' },
  'hierarchy.modelTagGroup.hideAriaLabel': 'Hide models tagged {name}',
  'hierarchy.modelTagGroup.showAriaLabel': 'Show models tagged {name}',
  'hierarchy.modelTagGroup.hideTooltip': 'Hide these models',
  'hierarchy.modelTagGroup.showTooltip': 'Show these models',

  // ModelRowTags
  'hierarchy.modelRowTags.unknownTag': 'Unknown tag',
  'hierarchy.modelRowTags.editTagsAriaLabel': 'Edit tags for model {name}',
  'hierarchy.modelRowTags.tooltip': 'Edit model tags',

  // ModelTagChip
  'hierarchy.modelTagChip.unknownTag': 'Unknown tag',
  'hierarchy.modelTagChip.unresolvedTitle': 'This tag no longer exists',
  'hierarchy.modelTagChip.removeAriaLabel': 'Remove tag {name}',

  // ModelTagEditor
  'hierarchy.modelTagEditor.title': 'Model tags',
  'hierarchy.modelTagEditor.descriptionAll': 'Labels for all {countDisplay} models. Tags are organisation only — they never change the IFC file.',
  'hierarchy.modelTagEditor.descriptionNamed': 'Labels for {name}. Tags are organisation only — they never change the IFC file.',
  'hierarchy.modelTagEditor.descriptionThisModel': 'Labels for this model. Tags are organisation only — they never change the IFC file.',
  'hierarchy.modelTagEditor.descriptionCount': { one: 'Labels for {countDisplay} model. Tags are organisation only — they never change the IFC file.', other: 'Labels for {countDisplay} models. Tags are organisation only — they never change the IFC file.' },
  'hierarchy.modelTagEditor.applyToAriaLabel': 'Apply to',
  'hierarchy.modelTagEditor.selected': 'Selected',
  'hierarchy.modelTagEditor.allModels': 'All {countDisplay} models',
  'hierarchy.modelTagEditor.addPlaceholder': 'Add a tag… (Enter)',
  'hierarchy.modelTagEditor.addAriaLabel': 'Add a tag',
  'hierarchy.modelTagEditor.assign': 'Assign',
  'hierarchy.modelTagEditor.create': 'Create',
  'hierarchy.modelTagEditor.matchingTagsAriaLabel': 'Matching tags',
  'hierarchy.modelTagEditor.allTagsAriaLabel': 'All tags',
  'hierarchy.modelTagEditor.emptyState': 'No tags yet — type one above.',
  'hierarchy.modelTagEditor.removeTagAriaLabel': 'Remove tag {name}',
  'hierarchy.modelTagEditor.assignTagAriaLabel': 'Assign tag {name}',
  'hierarchy.modelTagEditor.renameAriaLabel': 'Rename tag {name}',
  'hierarchy.modelTagEditor.saveNameAriaLabel': 'Save name for {name}',
  'hierarchy.modelTagEditor.deleteAriaLabel': 'Delete tag {name}',
  'hierarchy.modelTagEditor.deleteTooltip': 'Delete this tag everywhere. Saved filters that name it will show it as unresolved.',
  'hierarchy.modelTagEditor.renameError': 'Name is empty or already used by another tag.',

  // ModelsSectionHeader
  'hierarchy.modelsSection.title': 'Models',
  'hierarchy.modelsSection.byTag': 'By tag',
  'hierarchy.modelsSection.byTagTooltip': 'Group the model rows by tag, with an Untagged group',
  'hierarchy.modelsSection.tagFilterActiveAriaLabel': 'Stop listing models tagged {name}',
  'hierarchy.modelsSection.tagFilterInactiveAriaLabel': 'List models tagged {name}',
  'hierarchy.modelsSection.tagFilterTooltip': 'List the models tagged {name} — this filters the rows, it does not hide models',
  'hierarchy.modelsSection.untagged': 'Untagged',
  'hierarchy.modelsSection.untaggedFilterActiveAriaLabel': 'Stop listing untagged models',
  'hierarchy.modelsSection.untaggedFilterInactiveAriaLabel': 'List untagged models',
  'hierarchy.modelsSection.untaggedFilterTooltip': 'List the models that carry no tag',
  'hierarchy.modelsSection.isolateMatching': 'Isolate matching models',
  'hierarchy.modelsSection.isolateMatchingTooltip': 'Show the listed models and hide every other model in the viewport',
  'hierarchy.modelsSection.clear': 'Clear',
  'hierarchy.modelsSection.clearFilterAriaLabel': 'Clear model tag filter',
  'hierarchy.modelsSection.matchingCount': '{matching} of {total}',

  // HierarchySortControl
  'hierarchy.sortControl.tooltip': 'Sort the spatial browser (storeys and their contents)',
  'hierarchy.sortControl.triggerElevation': 'Sort: Elevation',
  'hierarchy.sortControl.triggerName': 'Sort: Name',
  'hierarchy.sortControl.label.elevationDesc': 'Elevation, high to low',
  'hierarchy.sortControl.label.elevationAsc': 'Elevation, low to high',
  'hierarchy.sortControl.label.nameAsc': 'Name, A to Z',
  'hierarchy.sortControl.label.nameDesc': 'Name, Z to A',

  // StoreyDisplayControls
  'hierarchy.storeyControls.stacked': 'Stacked',
  'hierarchy.storeyControls.stackedHint': 'Show every storey at its real elevation (the default view)',
  'hierarchy.storeyControls.solo': 'Solo',
  'hierarchy.storeyControls.soloHint': 'Show only one storey, click a storey below to pick it',
  'hierarchy.storeyControls.exploded': 'Exploded',
  'hierarchy.storeyControls.explodedHint': 'Lift each storey apart vertically for a sectioned, drawing-like view',
  'hierarchy.storeyControls.floorplanAriaLabel': 'Floorplan the active storey',
  'hierarchy.storeyControls.floorplanTooltip': 'Top-down floorplan of {name}',
  'hierarchy.storeyControls.floorplanPickTooltip': 'Pick a storey to floorplan it',
  'hierarchy.storeyControls.gapLabel': 'Gap',
  'hierarchy.storeyControls.gapUnitLabel': 'm between levels',
  'hierarchy.storeyControls.soloHintWithStorey': 'Showing only {name} · click another storey to switch, or click it again for all',
  'hierarchy.storeyControls.soloHintNoStorey': 'Click a storey below to show only it',
  'hierarchy.storeyControls.stackedHintClickStorey': 'Click a storey below to show only that level',

  // HierarchyPanel: header / empty states
  'hierarchy.panel.title': 'Hierarchy',
  'hierarchy.panel.noModelTitle': 'No Model',
  'hierarchy.panel.noModelHint': 'Structure will appear here when loaded',
  'hierarchy.panel.searchPlaceholder': 'Search...',
  'hierarchy.panel.noMatches': 'No matches for “{query}”',
  'hierarchy.panel.clearSearch': 'Clear search',

  // HierarchyPanel: grouping-mode tab strip
  'hierarchy.panel.grouping.spatial': 'Spatial',
  'hierarchy.panel.grouping.class': 'Class',
  'hierarchy.panel.grouping.type': 'Type',
  'hierarchy.panel.grouping.materialsTooltip': 'Materials',
  'hierarchy.panel.grouping.material': 'Material',
  'hierarchy.panel.grouping.groupsTooltip': 'Groups, systems and zones',
  'hierarchy.panel.grouping.groups': 'Groups',

  // HierarchyPanel: Groups-tab sub-filter chips
  'hierarchy.panel.groupFilter.all': 'All',
  'hierarchy.panel.groupFilter.systems': 'Systems',
  'hierarchy.panel.groupFilter.zones': 'Zones',
  'hierarchy.panel.groupFilter.other': 'Other',

  // HierarchyPanel: section headers per grouping mode
  'hierarchy.panel.sectionTitle.spatial': 'Hierarchy',
  'hierarchy.panel.sectionTitle.byClass': 'By Class',
  'hierarchy.panel.sectionTitle.byMaterial': 'By Material',
  'hierarchy.panel.sectionTitle.byGroup': 'By Group',
  'hierarchy.panel.sectionTitle.byType': 'By Type',
  'hierarchy.panel.buildingStoreysTitle': 'Building Storeys',

  // HierarchyPanel: footer filter chips + resize/status hints
  'hierarchy.panel.storeyCount': { one: '{count} Storey', other: '{count} Storeys' },
  'hierarchy.panel.clearStoreyFilterAriaLabel': 'Clear storey filter',
  'hierarchy.panel.clearClassFilterAriaLabel': 'Clear class filter',
  'hierarchy.panel.clearTypeFilterAriaLabel': 'Clear type filter',
  'hierarchy.panel.escHint': 'ESC',
  'hierarchy.panel.clearAllButton': 'Clear all',
  'hierarchy.panel.modelsFooterHint': '{count} models · Drag divider to resize',
  'hierarchy.panel.clickToFilterHint': 'Click to filter · Ctrl toggle',
} as const satisfies Record<string, TranslationValue>;
