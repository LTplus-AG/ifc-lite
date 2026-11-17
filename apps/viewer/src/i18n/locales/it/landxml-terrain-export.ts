/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const landXmlTerrainExportIt = {
  'landXmlTerrainExport.triggerButton': 'Esporta LandXML (terreno)',
  'landXmlTerrainExport.dialogTitle': 'Esporta LandXML (terreno)',
  'landXmlTerrainExport.dialogDescription':
    'Scrive il terreno selezionato come superficie LandXML 1.2 (punti e triangoli) nelle coordinate cartografiche del progetto.',
  'landXmlTerrainExport.cancelButton': 'Annulla',
  'landXmlTerrainExport.exportButton': 'Esporta',
  'landXmlTerrainExport.exportingButton': 'Esportazione in corso...',
  'landXmlTerrainExport.successTitle': 'Esportato',
  'landXmlTerrainExport.errorTitle': 'Esportazione non riuscita',
  'landXmlTerrainExport.noSelectionTitle': 'Seleziona un terreno',
  'landXmlTerrainExport.noSelectionDescription':
    'Seleziona il terreno da esportare: un IfcGeographicElement o un IfcSite la cui forma è una superficie triangolata.',
  'landXmlTerrainExport.multipleModelsTitle': 'Terreno da più di un modello',
  'landXmlTerrainExport.multipleModelsDescription':
    'Il terreno selezionato proviene da {count} modelli. Seleziona il terreno di un solo modello alla volta.',
  'landXmlTerrainExport.skippedNote': {
    one: '{count} oggetto selezionato non è un terreno e viene escluso.',
    many: '{count} oggetti selezionati non sono terreno e vengono esclusi.',
    other: '{count} oggetti selezionati non sono terreno e vengono esclusi.',
  },
  'landXmlTerrainExport.checking': 'Verifica del terreno selezionato...',
  'landXmlTerrainExport.refusedTitle': 'Questa selezione non può essere esportata',
  'landXmlTerrainExport.unavailableDescription': 'Il motore geometrico non è disponibile. Ricarica la pagina e riprova.',
  'landXmlTerrainExport.checkFailedTitle': 'Impossibile verificare il terreno',
  'landXmlTerrainExport.surfacesHeading': {
    one: '{count} superficie',
    many: '{count} superfici',
    other: '{count} superfici',
  },
  'landXmlTerrainExport.surfaceNameColumn': 'Superficie',
  'landXmlTerrainExport.pointsColumn': 'Punti',
  'landXmlTerrainExport.trianglesColumn': 'Triangoli',
  'landXmlTerrainExport.crsLabel': 'Sistema di coordinate: {crsName}',
  'landXmlTerrainExport.surfaceNameInput': 'Nome per la superficie {name}',
  'landXmlTerrainExport.outputLabel': 'Output',
  'landXmlTerrainExport.outputFormat': 'LandXML 1.2',
  'landXmlTerrainExport.fileExtension': '.xml',
  'landXmlTerrainExport.unitsLabel': 'Unità',
  'landXmlTerrainExport.unit.metre': 'Metri',
  'landXmlTerrainExport.unit.internationalFoot': 'Piedi internazionali',
  'landXmlTerrainExport.unit.usSurveyFoot': 'Piedi topografici USA',
  'landXmlTerrainExport.usSurveyFootNote':
    'Le altezze sono scritte in piedi internazionali, perché LandXML 1.2 non prevede il piede topografico USA per le altezze. Il file dichiara entrambe le unità.',
  'landXmlTerrainExport.decimalsLabel': 'Cifre decimali',
  'landXmlTerrainExport.decimals.3': '3 (0,001)',
  'landXmlTerrainExport.decimals.4': '4 (0,0001)',
  'landXmlTerrainExport.decimals.6': '6 (0,000001)',
  'landXmlTerrainExport.exportedMessage': 'Terreno LandXML esportato ({sizeKb} KB)',
  'landXmlTerrainExport.failedMessage': 'Esportazione del terreno LandXML non riuscita: {reason}',
} satisfies Catalogue;
