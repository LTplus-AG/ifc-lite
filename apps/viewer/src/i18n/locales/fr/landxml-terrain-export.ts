/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const landXmlTerrainExportFr = {
  'landXmlTerrainExport.triggerButton': 'Exporter en LandXML (terrain)',
  'landXmlTerrainExport.dialogTitle': 'Exporter en LandXML (terrain)',
  'landXmlTerrainExport.dialogDescription':
    'Écrit le terrain sélectionné sous forme de surface LandXML 1.2 (points et triangles) dans les coordonnées cartographiques du projet.',
  'landXmlTerrainExport.cancelButton': 'Annuler',
  'landXmlTerrainExport.exportButton': 'Exporter',
  'landXmlTerrainExport.exportingButton': 'Export en cours…',
  'landXmlTerrainExport.successTitle': 'Exporté',
  'landXmlTerrainExport.errorTitle': 'Échec de l’export',
  'landXmlTerrainExport.noSelectionTitle': 'Sélectionnez un terrain',
  'landXmlTerrainExport.noSelectionDescription':
    'Sélectionnez le terrain à exporter : un IfcGeographicElement ou un IfcSite dont la forme est une surface triangulée.',
  'landXmlTerrainExport.multipleModelsTitle': 'Terrain provenant de plusieurs modèles',
  'landXmlTerrainExport.multipleModelsDescription':
    'Le terrain sélectionné provient de {count} modèles. Sélectionnez le terrain d’un seul modèle à la fois.',
  'landXmlTerrainExport.skippedNote': {
    one: '{count} objet sélectionné n’est pas un terrain et est écarté.',
    many: '{count} d’objets sélectionnés ne sont pas des terrains et sont écartés.',
    other: '{count} objets sélectionnés ne sont pas des terrains et sont écartés.',
  },
  'landXmlTerrainExport.checking': 'Vérification du terrain sélectionné…',
  'landXmlTerrainExport.refusedTitle': 'Cette sélection ne peut pas être exportée',
  'landXmlTerrainExport.unavailableDescription': 'Le moteur géométrique n’est pas disponible. Rechargez la page et réessayez.',
  'landXmlTerrainExport.checkFailedTitle': 'Impossible de vérifier le terrain',
  'landXmlTerrainExport.surfacesHeading': {
    one: '{count} surface',
    many: '{count} de surfaces',
    other: '{count} surfaces',
  },
  'landXmlTerrainExport.surfaceNameColumn': 'Surface',
  'landXmlTerrainExport.pointsColumn': 'Points',
  'landXmlTerrainExport.trianglesColumn': 'Triangles',
  'landXmlTerrainExport.crsLabel': 'Système de coordonnées : {crsName}',
  'landXmlTerrainExport.surfaceNameInput': 'Nom de la surface {name}',
  'landXmlTerrainExport.outputLabel': 'Sortie',
  'landXmlTerrainExport.outputFormat': 'LandXML 1.2',
  'landXmlTerrainExport.fileExtension': '.xml',
  'landXmlTerrainExport.unitsLabel': 'Unités',
  'landXmlTerrainExport.unit.metre': 'Mètres',
  'landXmlTerrainExport.unit.internationalFoot': 'Pieds internationaux',
  'landXmlTerrainExport.unit.usSurveyFoot': 'Pieds d’arpentage américains',
  'landXmlTerrainExport.usSurveyFootNote':
    'Les hauteurs sont écrites en pieds internationaux, car LandXML 1.2 ne prévoit pas de pied d’arpentage américain pour les hauteurs. Le fichier indique les deux unités.',
  'landXmlTerrainExport.decimalsLabel': 'Décimales',
  'landXmlTerrainExport.decimals.3': '3 (0,001)',
  'landXmlTerrainExport.decimals.4': '4 (0,0001)',
  'landXmlTerrainExport.decimals.6': '6 (0,000001)',
  'landXmlTerrainExport.exportedMessage': 'Terrain LandXML exporté ({sizeKb} Ko)',
  'landXmlTerrainExport.failedMessage': 'Échec de l’export du terrain LandXML : {reason}',
} satisfies Catalogue;
