/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Rhino (.3dm) export dialog, `RhinoExportDialog.tsx`. The registry labels
 * (ribbon, palette, mobile) live in `shared-commands.en.ts`. Exporter warnings
 * are the scene builder's own text and are shown untranslated.
 */
import type { TranslationValue } from '../types';

export const rhinoExportEn = {
  'rhinoExport.triggerButton': 'Export Rhino (.3dm)',
  'rhinoExport.dialogTitle': 'Export Rhino (.3dm)',
  'rhinoExport.dialogDescription':
    'Writes the model as Rhino meshes on layers, with IFC properties as attribute user text.',
  'rhinoExport.modelLabel': 'Model',
  'rhinoExport.selectModelPlaceholder': 'Select model',

  'rhinoExport.unitsLabel': 'Units',
  'rhinoExport.units.source': 'Source unit',
  'rhinoExport.units.meters': 'Meters',
  'rhinoExport.units.millimeters': 'Millimeters',
  'rhinoExport.units.centimeters': 'Centimeters',
  'rhinoExport.units.feet': 'Feet',
  'rhinoExport.units.inches': 'Inches',

  'rhinoExport.layerSchemeLabel': 'Layers',
  'rhinoExport.layerScheme.spatial-class': 'Storey, then class',
  'rhinoExport.layerScheme.class': 'Class',
  'rhinoExport.layerScheme.presentation': 'Presentation layer',

  'rhinoExport.propertiesLabel': 'Properties',
  'rhinoExport.properties.all': 'Attributes, property sets and quantities',
  'rhinoExport.properties.attributes': 'Attributes only',
  'rhinoExport.properties.none': 'None',

  'rhinoExport.coordinatesLabel': 'Coordinates',
  'rhinoExport.coordinates.local': 'Local (shifted near origin)',
  'rhinoExport.coordinates.world': 'World (as in the IFC file)',
  'rhinoExport.coordinatesHint':
    'Keep Local for models far from the origin; the shift is recorded in the document user text and earth anchor.',

  'rhinoExport.versionLabel': '3dm version',
  'rhinoExport.version.8': 'Rhino 8',
  'rhinoExport.version.7': 'Rhino 7',

  'rhinoExport.instancingLabel': 'Blocks',
  'rhinoExport.instancingHint': 'Write repeated geometry once as a block definition with instances.',
  'rhinoExport.includeSpacesLabel': 'Include spaces',
  'rhinoExport.includeSpacesHint': 'IfcSpace objects go on a hidden layer.',
  'rhinoExport.visibleOnlyLabel': 'Only visible elements',
  'rhinoExport.visibleOnlyHint': 'Leave out what is hidden or isolated away in the viewer.',

  'rhinoExport.progress.scene': 'Building the scene...',
  'rhinoExport.progress.objects': 'Writing objects: {done} of {total}',
  'rhinoExport.progress.serialize': 'Saving the .3dm file...',
  'rhinoExport.stopButton': 'Stop',

  'rhinoExport.noSourceTitle': 'No source available',
  'rhinoExport.noSourceDescription':
    'Rhino export needs the original .ifc or .ifczip file. Re-open the model from disk to enable it.',
  'rhinoExport.successTitle': 'Success',
  'rhinoExport.errorTitle': 'Error',
  'rhinoExport.exportedMessage': 'Exported Rhino .3dm ({sizeKb} KB)',
  'rhinoExport.cancelledMessage': 'Rhino export stopped',
  'rhinoExport.noRenderGeometryError':
    'The Rhino export has nothing to write: the model has no render geometry, or the visibility filters removed all of it.',
  'rhinoExport.failedMessage': 'Rhino export failed: {reason}',
  'rhinoExport.cancelButton': 'Cancel',
  'rhinoExport.exportingButton': 'Exporting...',
  'rhinoExport.exportButton': 'Export',
} as const satisfies Record<string, TranslationValue>;
