/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * `ExportDialog.tsx`'s own chrome (#4918 slice: export/panel outer chrome):
 * the trigger button, dialog title/description, scope/mixed-units/model/
 * schema selectors, the schema-conversion warning, the output indicator,
 * every option switch and its hint text, the pending-changes banner, the
 * progress readout, the success/error result banner, and the footer
 * cancel/export controls. Schema version codes (`IFC2X3`, `IFC4`, …) and
 * file extensions remain exact identifiers and stay out of this catalogue.
 */
export const exportDialogEn = {
  'exportDialog.trigger': 'Export IFC',
  'exportDialog.title': 'Export IFC File',
  'exportDialog.description.ifc5': 'Export model data and geometry, including current workspace placement',
  'exportDialog.description.default': 'Export authored model coordinates and property modifications. Workspace repositioning is saved separately.',
  'exportDialog.scopeLabel': 'Scope',
  'exportDialog.scope.single': 'Single Model',
  'exportDialog.scope.merged': 'Merged (All Models)',
  'exportDialog.mixedUnitsLabel': 'Mixed units',
  'exportDialog.unitReconciliation.auto': 'Keep each unit (separate projects)',
  'exportDialog.unitReconciliation.normalize': 'Normalize to first model',
  'exportDialog.unitReconciliation.assumeShared': 'Assume shared unit',
  'exportDialog.modelLabel': 'Model',
  'exportDialog.selectModelPlaceholder': 'Select model',
  'exportDialog.schemaLabel': 'Schema',
  'exportDialog.schemaOption.ifc5Alpha': 'IFC5 (Alpha)',
  'exportDialog.currentSchemaSuffix': ' (current)',
  'exportDialog.schemaUpgradeTitle': 'Schema Upgrade',
  'exportDialog.schemaDowngradeTitle': 'Schema Downgrade',
  'exportDialog.conversionSummary': 'Converting from {source} to {target}.',
  'exportDialog.schemaDowngradeNote': 'Some data may be lost in the conversion to an older schema.',
  'exportDialog.schemaUpgradeNote': 'Entity types will be mapped to the newer schema.',
  'exportDialog.outputLabel': 'Output',
  'exportDialog.visibleOnlyLabel': 'Export Visible Only',
  'exportDialog.visibleOnlyHint': 'Only include entities currently visible in the 3D view',
  'exportDialog.includeGeometryLabel': 'Include Geometry',
  'exportDialog.applyMutationsLabel': 'Apply Property Changes',
  'exportDialog.changesOnlyLabel.default': 'Changes only (JSON delta)',
  'exportDialog.changesOnlyLabel.ifc5': 'Changes only (IFCX overlay)',
  'exportDialog.changesOnlyHint.ifc5': 'Export as IFCX overlay with mutations only',
  'exportDialog.changesOnlyHint.default': 'Export mutations as JSON delta',
  'exportDialog.onlyKnownPropertiesLabel': 'Only Known IFC5 Properties',
  'exportDialog.onlyKnownPropertiesHint': 'Skip properties without an official IFC5 schema (avoids viewer warnings)',
  'exportDialog.pendingChangesTitle': 'Pending Changes',
  'exportDialog.pendingChangesDescription': {
    one: '{countDisplay} entity has been modified',
    other: '{countDisplay} entities have been modified',
  },
  'exportDialog.progressCount': '{processed} / {total} entities',
  'exportDialog.resultSuccessTitle': 'Success',
  'exportDialog.resultErrorTitle': 'Error',
  'exportDialog.cancelButton': 'Cancel',
  'exportDialog.exportingLabel': 'Exporting...',
  'exportDialog.exportButton': 'Export',
  'exportDialog.landXml.title': 'LandXML cannot be exported as IFC',
  'exportDialog.landXml.description': 'Its terrain records remain in their original source format; no IFC entities are synthesized for export.',
  'exportDialog.landXml.error': 'LandXML is source geometry, not IFC. Export the original LandXML file instead.',
  'exportDialog.landXml.downloadSource': 'Download original LandXML',
  'exportDialog.landXml.sourceUnavailable': 'The original file is no longer held in memory, so it cannot be re-saved from here. Reopen it to export the source.',
  'exportDialog.landXml.convertTitle': 'LandXML will be converted to IFC4X3',
  'exportDialog.landXml.convertSurfaces': {
    one: '{count} terrain surface',
    other: '{count} terrain surfaces',
  },
  'exportDialog.landXml.convertPoints': {
    one: '{count} survey point',
    other: '{count} survey points',
  },
  'exportDialog.landXml.convertAlignments': {
    one: '{count} alignment',
    other: '{count} alignments',
  },
  'exportDialog.landXml.convertSummary': 'This is a one-way derived conversion, not a round trip. {records} will be written.',
  'exportDialog.landXml.excludedTitle': 'Not included in the IFC',
  'exportDialog.landXml.assumedUnit': 'Coordinates are scaled by an assumed linear unit ({unit}), not one the source declares. The geometry is at an operator-chosen scale.',
  'exportDialog.landXml.missingCrs': 'No coordinate reference system is declared, so no georeferencing is written and the coordinate-order check cannot run.',
  'exportDialog.landXml.declaredCrs': 'Georeferencing is written for the declared datum ({crs}), but the coordinate-order check cannot run: ifc-lite does not resolve a datum name to its coordinate bounds. A source whose point text was written easting-first produces a mirrored surface that still renders, so verify the source before relying on the position.',
  'exportDialog.landXml.mergedUnsupported': 'The LandXML mapping converts one file into a standalone IFC4X3 model; it cannot take part in a merged export. Switch the scope to a single model to convert it.',
  'exportDialog.landXml.schemaUnsupported': 'The LandXML mapping derives IFC4X3 STEP only. Choose IFC4X3 to convert this model, or export the original LandXML file.',
  'exportDialog.landXml.exported': 'Converted to IFC4X3: {records}.',
} as const satisfies Record<string, TranslationValue>;
