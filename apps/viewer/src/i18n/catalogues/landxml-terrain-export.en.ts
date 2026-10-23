/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The "LandXML (terrain)" export dialog, `LandXmlTerrainExportDialog.tsx`
 * (#7600). The registry labels (ribbon, palette, mobile) live in
 * `shared-commands.en.ts`. Surface names, the CRS name and the refusal reason
 * are model content or the producer's own text and are never translated here.
 */
export const landXmlTerrainExportEn = {
  'landXmlTerrainExport.triggerButton': 'Export LandXML (terrain)',
  'landXmlTerrainExport.dialogTitle': 'Export LandXML (terrain)',
  'landXmlTerrainExport.dialogDescription':
    'Writes the selected terrain as a LandXML 1.2 surface (points and triangles) in the project map coordinates.',
  'landXmlTerrainExport.cancelButton': 'Cancel',
  'landXmlTerrainExport.exportButton': 'Export',
  'landXmlTerrainExport.exportingButton': 'Exporting...',
  'landXmlTerrainExport.successTitle': 'Exported',
  'landXmlTerrainExport.errorTitle': 'Export failed',

  'landXmlTerrainExport.noSelectionTitle': 'Select a terrain',
  'landXmlTerrainExport.noSelectionDescription':
    'Select the terrain to export: an IfcGeographicElement or IfcSite whose shape is a triangulated surface.',
  'landXmlTerrainExport.multipleModelsTitle': 'Terrain from more than one model',
  'landXmlTerrainExport.multipleModelsDescription':
    'The selected terrain comes from {count} models. Select terrain from one model at a time.',
  'landXmlTerrainExport.skippedNote': {
    one: '{count} selected object is not a terrain and is left out.',
    other: '{count} selected objects are not terrain and are left out.',
  },

  'landXmlTerrainExport.checking': 'Checking the selected terrain...',
  'landXmlTerrainExport.refusedTitle': 'This selection cannot be exported',
  'landXmlTerrainExport.unavailableDescription': 'The geometry engine is not available. Reload the page and try again.',
  'landXmlTerrainExport.checkFailedTitle': 'Could not check the terrain',

  'landXmlTerrainExport.surfacesHeading': {
    one: '{count} surface',
    other: '{count} surfaces',
  },
  'landXmlTerrainExport.surfaceNameColumn': 'Surface',
  'landXmlTerrainExport.pointsColumn': 'Points',
  'landXmlTerrainExport.trianglesColumn': 'Triangles',
  'landXmlTerrainExport.crsLabel': 'Coordinate system: {crsName}',
  'landXmlTerrainExport.surfaceNameInput': 'Name for surface {name}',

  'landXmlTerrainExport.outputLabel': 'Output',
  'landXmlTerrainExport.outputFormat': 'LandXML 1.2',
  'landXmlTerrainExport.fileExtension': '.xml',
  'landXmlTerrainExport.unitsLabel': 'Units',
  'landXmlTerrainExport.unit.metre': 'Metres',
  'landXmlTerrainExport.unit.internationalFoot': 'International feet',
  'landXmlTerrainExport.unit.usSurveyFoot': 'US survey feet',
  'landXmlTerrainExport.usSurveyFootNote':
    'Heights are written in international feet, because LandXML 1.2 has no US survey foot for heights. The file states both units.',
  'landXmlTerrainExport.decimalsLabel': 'Decimal places',
  'landXmlTerrainExport.decimals.3': '3 (0.001)',
  'landXmlTerrainExport.decimals.4': '4 (0.0001)',
  'landXmlTerrainExport.decimals.6': '6 (0.000001)',

  'landXmlTerrainExport.exportedMessage': 'Exported LandXML terrain ({sizeKb} KB)',
  'landXmlTerrainExport.failedMessage': 'LandXML terrain export failed: {reason}',
} as const satisfies Record<string, TranslationValue>;
