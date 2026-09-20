/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The "Export anonymized subset" dialog (#2934, #4918 slice: anonymized
 * export), covering `AnonymizedExportDialog.tsx`'s own chrome and its four
 * sub-panels: the anonymization toggle rows (`AnonymizationOptionsPanel.tsx`),
 * the relationship-expansion toggles (`RelationTogglePanel.tsx`), the
 * checkable seed/related-entity list (`RelatedEntityList.tsx`), and the
 * per-IFC-class chip bar (`TypeCategoryBar.tsx`). IFC class NAMES
 * (`c.typeName`), entity NAMES/ids, and relationship/role identifiers used
 * to build a group's label are model content and stay out of the
 * catalogue; only the surrounding labels, hints, and status messages are
 * translated here.
 */
export const anonymizedExportEn = {
  // AnonymizationOptionsPanel
  'anonymizedExport.options.heading': 'Anonymization',
  'anonymizedExport.options.keepLabel': 'Keep',
  'anonymizedExport.options.anonymizeLabel': 'Anonymize',
  'anonymizedExport.options.toggleAriaLabel': 'Anonymize {label}',
  'anonymizedExport.options.keptAsAuthored': 'kept as authored',
  'anonymizedExport.options.namesLabel': 'Names',
  'anonymizedExport.options.namesEffect': 'Name/LongName/Description/Tag become IfcType-n',
  'anonymizedExport.options.otherNamesLabel': 'Other names',
  'anonymizedExport.options.otherNamesEffect': 'ObjectType, styles, materials, layers, profiles',
  'anonymizedExport.options.globalIdsLabel': 'GUIDs',
  'anonymizedExport.options.globalIdsEffect': 'GlobalIds regenerated',
  'anonymizedExport.options.propertySetsLabel': 'Property sets',
  'anonymizedExport.options.propertySetsEffect': 'Property and quantity sets dropped',
  'anonymizedExport.options.rootPlacementLabel': 'Root placement position',
  'anonymizedExport.options.rootPlacementEffect': 'Root translation zeroed; rotation kept',
  'anonymizedExport.options.georeferencingLabel': 'Georeferencing & addresses',
  'anonymizedExport.options.georeferencingEffect': 'Map conversion, CRS, lat/long, addresses removed',
  'anonymizedExport.options.currencyLabel': 'Currency',
  'anonymizedExport.options.currencyEffect': 'IfcMonetaryUnit becomes USD',

  // RelationTogglePanel
  'anonymizedExport.relations.heading': 'Expand with related',
  'anonymizedExport.relations.connectedAriaLabel': 'Connected elements',
  'anonymizedExport.relations.connectedDepthLabel': 'Connected, depth',
  'anonymizedExport.relations.openingsLabel': 'Openings',
  'anonymizedExport.relations.fillingsLabel': 'Fillings & host',
  'anonymizedExport.relations.aggregatesLabel': 'Aggregates & nesting (parents/children)',
  'anonymizedExport.relations.typeObjectsLabel': 'Type objects',
  'anonymizedExport.relations.materialsLabel': 'Materials',
  'anonymizedExport.relations.propertySetsSourceLabel': 'Property sets (source)',

  // RelatedEntityList
  'anonymizedExport.relatedList.seedsLabel': 'Seeds',
  'anonymizedExport.relatedList.groupLabel': '{relationship} ({role})',
  'anonymizedExport.relatedList.entityFallbackType': 'Entity',
  'anonymizedExport.relatedList.toggleAllAriaLabel': 'Toggle all {label}',
  'anonymizedExport.relatedList.lockedBadge': 'locked',
  'anonymizedExport.relatedList.emptyState': 'No entities to export yet.',

  // TypeCategoryBar
  'anonymizedExport.typeCategoryBar.heading': 'Categories in export',
  'anonymizedExport.typeCategoryBar.blockedCountPrefix': '{count} blocked · ',
  'anonymizedExport.typeCategoryBar.clickToBlockHint': 'click a category to block it',
  'anonymizedExport.typeCategoryBar.unblockAriaLabel': 'Unblock {typeName}',
  'anonymizedExport.typeCategoryBar.blockAriaLabel': 'Block {typeName}',
  'anonymizedExport.typeCategoryBar.alwaysIncludedTitle': 'Always included (selection or spatial chain)',
  'anonymizedExport.typeCategoryBar.blockedTitle': 'Blocked — click to include',
  'anonymizedExport.typeCategoryBar.includedTitle': 'Included — click to block',

  // AnonymizedExportDialog
  'anonymizedExport.dialog.title': 'Export Anonymized Subset',
  'anonymizedExport.dialog.description': 'Objects highlighted in the 3D view on the right are what gets exported — every project-identifying signal removed, local transformations kept.',
  'anonymizedExport.dialog.otherModelSeedsExcluded': {
    one: '{count} selected object in other models not included',
    other: '{count} selected objects in other models not included',
  },
  'anonymizedExport.dialog.droppedOverlaySeedsExcluded': {
    one: '{count} selected object created in this session has no source record and cannot be included',
    other: '{count} selected objects created in this session have no source record and cannot be included',
  },
  'anonymizedExport.dialog.noSelectionPrompt': 'Select one or more objects in the 3D view, then reopen this dialog.',
  'anonymizedExport.dialog.resultCount': {
    one: 'Result: {count} entity',
    other: 'Result: {count} entities',
  },
  'anonymizedExport.dialog.truncatedBadge': 'Truncated',
  'anonymizedExport.dialog.previewIn3dLabel': 'Preview in 3D',
  'anonymizedExport.dialog.exportingStatus': 'Exporting…',
  'anonymizedExport.dialog.successTitle': 'Success',
  'anonymizedExport.dialog.errorTitle': 'Error',
  'anonymizedExport.dialog.warningsSummary': {
    one: '{count} warning',
    other: '{count} warnings',
  },
  'anonymizedExport.dialog.fileNameLabel': 'File name',
  'anonymizedExport.dialog.ifcExtensionSuffix': '.ifc',
  'anonymizedExport.dialog.cancelButton': 'Cancel',
  'anonymizedExport.dialog.exportingButton': 'Exporting...',
  'anonymizedExport.dialog.exportButtonLabel': 'Export .ifc',
  'anonymizedExport.dialog.previewCaption': {
    one: '3D preview — {count} highlighted object will be exported',
    other: '3D preview — {count} highlighted objects will be exported',
  },
  'anonymizedExport.dialog.modelDataUnavailableError': 'Model data is unavailable for export',
  'anonymizedExport.dialog.exportedEntities': {
    one: 'Exported {count} entity',
    other: 'Exported {count} entities',
  },
  'anonymizedExport.dialog.exportedEntitiesWithWarnings': {
    one: 'Exported {count} entity ({warnings} warnings)',
    other: 'Exported {count} entities ({warnings} warnings)',
  },
  'anonymizedExport.dialog.exportFailedMessage': 'Export failed: {message}',
  'anonymizedExport.dialog.unknownError': 'Unknown error',
} as const satisfies Record<string, TranslationValue>;
