/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const rhinoExportIt = {
  'rhinoExport.triggerButton': 'Esporta Rhino (.3dm)',
  'rhinoExport.dialogTitle': 'Esporta Rhino (.3dm)',
  'rhinoExport.dialogDescription':
    'Scrive il modello come mesh Rhino su layer, con le proprietà IFC come testo utente degli attributi.',
  'rhinoExport.modelLabel': 'Modello',
  'rhinoExport.selectModelPlaceholder': 'Seleziona modello',
  'rhinoExport.unitsLabel': 'Unità',
  'rhinoExport.units.source': 'Unità del file sorgente',
  'rhinoExport.units.meters': 'Metri',
  'rhinoExport.units.millimeters': 'Millimetri',
  'rhinoExport.units.centimeters': 'Centimetri',
  'rhinoExport.units.feet': 'Piedi',
  'rhinoExport.units.inches': 'Pollici',
  'rhinoExport.layerSchemeLabel': 'Layer',
  'rhinoExport.layerScheme.spatial-class': 'Piano, poi classe',
  'rhinoExport.layerScheme.class': 'Classe',
  'rhinoExport.layerScheme.presentation': 'Layer di presentazione',
  'rhinoExport.propertiesLabel': 'Proprietà',
  'rhinoExport.properties.all': 'Attributi, insiemi di proprietà e quantità',
  'rhinoExport.properties.attributes': 'Solo attributi',
  'rhinoExport.properties.none': 'Nessuna',
  'rhinoExport.coordinatesLabel': 'Coordinate',
  'rhinoExport.coordinates.local': "Locali (spostate vicino all'origine)",
  'rhinoExport.coordinates.world': 'Globali (come nel file IFC)',
  'rhinoExport.coordinatesHint':
    "Per i modelli lontani dall'origine mantieni Locali; lo spostamento è registrato nel testo utente del documento e nell'ancoraggio terrestre.",
  'rhinoExport.versionLabel': 'Versione 3dm',
  'rhinoExport.version.8': 'Rhino 8',
  'rhinoExport.version.7': 'Rhino 7',
  'rhinoExport.instancingLabel': 'Blocchi',
  'rhinoExport.instancingHint': 'Scrive la geometria ripetuta una sola volta come definizione di blocco con istanze.',
  'rhinoExport.includeSpacesLabel': 'Includi gli spazi',
  'rhinoExport.includeSpacesHint': 'Gli oggetti IfcSpace vanno su un layer nascosto.',
  'rhinoExport.visibleOnlyLabel': 'Solo elementi visibili',
  'rhinoExport.visibleOnlyHint': "Esclude ciò che nel viewer è nascosto o escluso dall'isolamento.",
  'rhinoExport.progress.scene': 'Costruzione della scena...',
  'rhinoExport.progress.objects': 'Scrittura degli oggetti: {done} di {total}',
  'rhinoExport.progress.serialize': 'Salvataggio del file .3dm...',
  'rhinoExport.stopButton': 'Interrompi',
  'rhinoExport.noSourceTitle': 'Nessuna origine disponibile',
  'rhinoExport.noSourceDescription':
    "L'esportazione Rhino richiede il file .ifc o .ifczip originale. Riapri il modello dal disco.",
  'rhinoExport.successTitle': 'Operazione riuscita',
  'rhinoExport.errorTitle': 'Errore',
  'rhinoExport.exportedMessage': 'Rhino .3dm esportato ({sizeKb} KB)',
  'rhinoExport.cancelledMessage': 'Esportazione Rhino interrotta',
  'rhinoExport.noRenderGeometryError':
    "L'esportazione Rhino non ha nulla da scrivere: il modello non ha geometria di rendering, oppure i filtri di visibilità l'hanno esclusa tutta.",
  'rhinoExport.failedMessage': 'Esportazione Rhino non riuscita: {reason}',
  'rhinoExport.cancelButton': 'Annulla',
  'rhinoExport.exportingButton': 'Esportazione...',
  'rhinoExport.exportButton': 'Esporta',
} satisfies Catalogue;
