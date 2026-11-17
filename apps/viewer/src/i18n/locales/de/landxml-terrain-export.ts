/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const landXmlTerrainExportDe = {
  'landXmlTerrainExport.triggerButton': 'LandXML exportieren (Gelände)',
  'landXmlTerrainExport.dialogTitle': 'LandXML exportieren (Gelände)',
  'landXmlTerrainExport.dialogDescription':
    'Schreibt das ausgewählte Gelände als LandXML-1.2-Oberfläche (Punkte und Dreiecke) in den Kartenkoordinaten des Projekts.',
  'landXmlTerrainExport.cancelButton': 'Abbrechen',
  'landXmlTerrainExport.exportButton': 'Exportieren',
  'landXmlTerrainExport.exportingButton': 'Wird exportiert …',
  'landXmlTerrainExport.successTitle': 'Exportiert',
  'landXmlTerrainExport.errorTitle': 'Export fehlgeschlagen',
  'landXmlTerrainExport.noSelectionTitle': 'Gelände auswählen',
  'landXmlTerrainExport.noSelectionDescription':
    'Wählen Sie das zu exportierende Gelände aus: ein IfcGeographicElement oder IfcSite, dessen Form eine triangulierte Oberfläche ist.',
  'landXmlTerrainExport.multipleModelsTitle': 'Gelände aus mehr als einem Modell',
  'landXmlTerrainExport.multipleModelsDescription':
    'Das ausgewählte Gelände stammt aus {count} Modellen. Wählen Sie jeweils Gelände aus nur einem Modell aus.',
  'landXmlTerrainExport.skippedNote': {
    one: '{count} ausgewähltes Objekt ist kein Gelände und wird ausgelassen.',
    other: '{count} ausgewählte Objekte sind kein Gelände und werden ausgelassen.',
  },
  'landXmlTerrainExport.checking': 'Ausgewähltes Gelände wird geprüft …',
  'landXmlTerrainExport.refusedTitle': 'Diese Auswahl kann nicht exportiert werden',
  'landXmlTerrainExport.unavailableDescription': 'Die Geometrie-Engine ist nicht verfügbar. Laden Sie die Seite neu und versuchen Sie es erneut.',
  'landXmlTerrainExport.checkFailedTitle': 'Das Gelände konnte nicht geprüft werden',
  'landXmlTerrainExport.surfacesHeading': {
    one: '{count} Oberfläche',
    other: '{count} Oberflächen',
  },
  'landXmlTerrainExport.surfaceNameColumn': 'Oberfläche',
  'landXmlTerrainExport.pointsColumn': 'Punkte',
  'landXmlTerrainExport.trianglesColumn': 'Dreiecke',
  'landXmlTerrainExport.crsLabel': 'Koordinatensystem: {crsName}',
  'landXmlTerrainExport.surfaceNameInput': 'Name für Oberfläche {name}',
  'landXmlTerrainExport.outputLabel': 'Ausgabe',
  'landXmlTerrainExport.outputFormat': 'LandXML 1.2',
  'landXmlTerrainExport.fileExtension': '.xml',
  'landXmlTerrainExport.unitsLabel': 'Einheiten',
  'landXmlTerrainExport.unit.metre': 'Meter',
  'landXmlTerrainExport.unit.internationalFoot': 'Internationale Fuß',
  'landXmlTerrainExport.unit.usSurveyFoot': 'US-Vermessungsfuß',
  'landXmlTerrainExport.usSurveyFootNote':
    'Höhen werden in internationalen Fuß geschrieben, da LandXML 1.2 keinen US-Vermessungsfuß für Höhen kennt. Die Datei gibt beide Einheiten an.',
  'landXmlTerrainExport.decimalsLabel': 'Nachkommastellen',
  'landXmlTerrainExport.decimals.3': '3 (0,001)',
  'landXmlTerrainExport.decimals.4': '4 (0,0001)',
  'landXmlTerrainExport.decimals.6': '6 (0,000001)',
  'landXmlTerrainExport.exportedMessage': 'LandXML-Gelände exportiert ({sizeKb} KB)',
  'landXmlTerrainExport.failedMessage': 'Export des LandXML-Geländes fehlgeschlagen: {reason}',
} satisfies Catalogue;
