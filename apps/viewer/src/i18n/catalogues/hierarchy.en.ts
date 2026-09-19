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

  // ModelTagGroupRow
  'hierarchy.modelTagGroup.memberCount': { one: '{count} model', other: '{count} models' },
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
  'hierarchy.modelTagEditor.descriptionScopeAll': 'all {count} models',
  'hierarchy.modelTagEditor.descriptionScopeThisModel': 'this model',
  'hierarchy.modelTagEditor.descriptionScopeCount': { one: '{count} model', other: '{count} models' },
  'hierarchy.modelTagEditor.description': 'Labels for {scope}. Tags are organisation only — they never change the IFC file.',
  'hierarchy.modelTagEditor.applyToAriaLabel': 'Apply to',
  'hierarchy.modelTagEditor.selected': 'Selected',
  'hierarchy.modelTagEditor.allModels': 'All {count} models',
  'hierarchy.modelTagEditor.addPlaceholder': 'Add a tag… (Enter)',
  'hierarchy.modelTagEditor.addAriaLabel': 'Add a tag',
  'hierarchy.modelTagEditor.assign': 'Assign',
  'hierarchy.modelTagEditor.create': 'Create',
  'hierarchy.modelTagEditor.matchingTagsAriaLabel': 'Matching tags',
  'hierarchy.modelTagEditor.allTagsAriaLabel': 'All tags',
  'hierarchy.modelTagEditor.emptyState': 'No tags yet — type one above.',
  'hierarchy.modelTagEditor.toggleAriaLabel': '{action} tag {name}',
  'hierarchy.modelTagEditor.toggleActionRemove': 'Remove',
  'hierarchy.modelTagEditor.toggleActionAssign': 'Assign',
  'hierarchy.modelTagEditor.renameAriaLabel': 'Rename tag {name}',
  'hierarchy.modelTagEditor.saveNameAriaLabel': 'Save name for {name}',
  'hierarchy.modelTagEditor.deleteAriaLabel': 'Delete tag {name}',
  'hierarchy.modelTagEditor.deleteTooltip': 'Delete this tag everywhere. Saved filters that name it will show it as unresolved.',
  'hierarchy.modelTagEditor.renameError': 'Name is empty or already used by another tag.',

  // ModelsSectionHeader
  'hierarchy.modelsSection.title': 'Models',
  'hierarchy.modelsSection.byTag': 'By tag',
  'hierarchy.modelsSection.byTagTooltip': 'Group the model rows by tag, with an Untagged group',
  'hierarchy.modelsSection.tagFilterAriaLabel': '{action} models tagged {name}',
  'hierarchy.modelsSection.tagFilterTooltip': 'List the models tagged {name} — this filters the rows, it does not hide models',
  'hierarchy.modelsSection.filterActionStop': 'Stop listing',
  'hierarchy.modelsSection.filterActionList': 'List',
  'hierarchy.modelsSection.untagged': 'Untagged',
  'hierarchy.modelsSection.untaggedFilterAriaLabel': '{action} untagged models',
  'hierarchy.modelsSection.untaggedFilterTooltip': 'List the models that carry no tag',
  'hierarchy.modelsSection.isolateMatching': 'Isolate matching models',
  'hierarchy.modelsSection.isolateMatchingTooltip': 'Show the listed models and hide every other model in the viewport',
  'hierarchy.modelsSection.clear': 'Clear',
  'hierarchy.modelsSection.clearFilterAriaLabel': 'Clear model tag filter',
  'hierarchy.modelsSection.matchingCount': '{matching} of {total}',

  // HierarchySortControl
  'hierarchy.sortControl.tooltip': 'Sort the spatial browser (storeys and their contents)',
  'hierarchy.sortControl.triggerLabel': 'Sort: {short}',
  'hierarchy.sortControl.short.elevation': 'Elevation',
  'hierarchy.sortControl.short.name': 'Name',
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
} as const satisfies Record<string, TranslationValue>;
