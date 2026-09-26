/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Data Connector dialog's own chrome (#4918 slice, `DataConnector.tsx`)
 * covers the CSV-import workflow: the trigger button, dialog header and
 * step indicator, the target-model and CSV-file pickers, the data-preview
 * table caption, the entity-matching controls (match-by/CSV-column/
 * property-set/property-name fields), the property-mapping list (its
 * header actions, empty state, column headers, and per-row field
 * placeholders and value-type options), the match-results/import-progress/
 * import-complete/error alerts, and the footer's preview/import buttons.
 * CSV column NAMES, sample cell VALUES, and model NAMES are runtime
 * content supplied by the user's own file or model and stay out of the
 * catalogue as interpolation params. `GlobalId` and `EXPRESS ID` describe
 * IFC's own match-by mechanisms (the EXPRESS attribute and the parser's
 * numeric express ID) and stay as their exact technical spelling, same
 * house rule as the rest of this sweep's IFC EXPRESS names — only routed
 * through `t()` so the ending gate does not see them as untranslated JSX
 * literals.
 */
export const dataConnectorEn = {
  'dataConnector.triggerButton': 'Import Data',
  'dataConnector.dialogTitle': 'Import External Data',
  'dataConnector.dialogDescription': 'Map CSV data to IFC entity properties',
  'dataConnector.step.upload': 'Upload CSV',
  'dataConnector.step.configure': 'Configure Mapping',
  'dataConnector.step.import': 'Import',

  'dataConnector.targetModelLabel': 'Target Model',
  'dataConnector.selectModelPlaceholder': 'Select a model',
  'dataConnector.mutationViewUnavailableNote':
    'Note: MutationView not available for this model. Some features may be limited.',

  'dataConnector.csvFileLabel': 'CSV File',
  'dataConnector.dropHereText': 'Drop CSV file here',
  'dataConnector.dragDropText': 'Drag & drop a CSV file',
  'dataConnector.clickToBrowseText': 'or click to browse',
  'dataConnector.changeFileButton': 'Change',

  'dataConnector.dataPreviewLabel': 'Data Preview',
  'dataConnector.rowsParsedCount': { one: '{countDisplay} row parsed', other: '{countDisplay} rows parsed' },
  'dataConnector.sampleRowsCount': { one: '{countDisplay} sample row', other: '{countDisplay} sample rows' },

  'dataConnector.entityMatchingLabel': 'Entity Matching',
  'dataConnector.matchByLabel': 'Match By',
  'dataConnector.matchTypeGlobalId': 'GlobalId',
  'dataConnector.matchTypeExpressId': 'EXPRESS ID',
  'dataConnector.matchTypeEntityName': 'Entity Name',
  'dataConnector.matchTypePropertyValue': 'Property Value',
  'dataConnector.csvColumnLabel': 'CSV Column',
  'dataConnector.selectColumnPlaceholder': 'Select column',
  'dataConnector.columnSampleHint': '(e.g., {sample})',
  'dataConnector.propertySetFieldLabel': 'Property Set',
  'dataConnector.propertySetPlaceholder': 'e.g., Pset_WallCommon',
  'dataConnector.propertyNameFieldLabel': 'Property Name',
  'dataConnector.propertyNamePlaceholder': 'e.g., Reference',

  'dataConnector.propertyMappingsLabel': 'Property Mappings',
  'dataConnector.autoDetectButton': 'Auto-detect',
  'dataConnector.addMappingButton': 'Add',
  'dataConnector.noMappingsText': 'No property mappings configured',
  'dataConnector.noMappingsHint': 'Click "Auto-detect" or "Add" to map CSV columns to IFC properties',
  'dataConnector.sourceColumnHeader': 'Source Column',
  'dataConnector.targetPsetHeader': 'Target Pset',
  'dataConnector.targetPropertyHeader': 'Target Property',
  'dataConnector.typeHeader': 'Type',
  'dataConnector.columnPlaceholder': 'Column',
  'dataConnector.psetNamePlaceholder': 'Pset name',
  'dataConnector.propertyPlaceholder': 'Property',
  'dataConnector.valueTypeString': 'String',
  'dataConnector.valueTypeReal': 'Real',
  'dataConnector.valueTypeInteger': 'Integer',
  'dataConnector.valueTypeBoolean': 'Boolean',

  'dataConnector.matchResultsTitle': 'Match Results',
  'dataConnector.matchedCount': '{countDisplay} matched',
  'dataConnector.unmatchedCount': '{countDisplay} unmatched',
  'dataConnector.highConfidenceCount': '{countDisplay} high confidence',
  'dataConnector.multiMatchCount': '{countDisplay} multi-match',

  'dataConnector.phaseParsing': 'Parsing CSV...',
  'dataConnector.phaseMatching': 'Matching entities...',
  'dataConnector.phaseApplying': 'Applying properties...',
  'dataConnector.writtenSuffix': ' · {countDisplay} written',

  'dataConnector.importCompleteTitle': 'Import Complete',
  'dataConnector.propertiesUpdatedCount': {
    one: '{countDisplay} property updated',
    other: '{countDisplay} properties updated',
  },
  'dataConnector.rowsMatchedCount': { one: '{countDisplay} row matched', other: '{countDisplay} rows matched' },
  'dataConnector.rowsUnmatchedCount': {
    one: '{countDisplay} row unmatched',
    other: '{countDisplay} rows unmatched',
  },
  'dataConnector.warningsCount': { one: '{countDisplay} warning', other: '{countDisplay} warnings' },

  'dataConnector.errorTitle': 'Error',

  'dataConnector.previewMatchesButton': 'Preview Matches',
  'dataConnector.editRequiresAccessTitle': 'Editing requires editor access in this shared session',
  'dataConnector.importButton': 'Import',
  'dataConnector.importRowsButton': { one: 'Import {countDisplay} row', other: 'Import {countDisplay} rows' },
  'dataConnector.removeMappingLabel': 'Remove mapping',
} as const satisfies Record<string, TranslationValue>;
