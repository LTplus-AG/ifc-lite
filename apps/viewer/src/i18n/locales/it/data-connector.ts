/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const dataConnectorIt = {
  "dataConnector.triggerButton": "Importa dati",
  "dataConnector.dialogTitle": "Importa dati esterni",
  "dataConnector.dialogDescription": "Associa dati CSV alle proprietà delle entità IFC",
  "dataConnector.step.upload": "Carica CSV",
  "dataConnector.step.configure": "Configura associazioni",
  "dataConnector.step.import": "Importa",
  "dataConnector.targetModelLabel": "Modello di destinazione",
  "dataConnector.selectModelPlaceholder": "Seleziona un modello",
  "dataConnector.mutationViewUnavailableNote": "Nota: MutationView non disponibile per questo modello. Alcune funzionalità potrebbero essere limitate.",
  "dataConnector.csvFileLabel": "File CSV",
  "dataConnector.dropHereText": "Rilascia qui il file CSV",
  "dataConnector.dragDropText": "Trascina e rilascia un file CSV",
  "dataConnector.clickToBrowseText": "oppure fai clic per sfogliare",
  "dataConnector.changeFileButton": "Cambia",
  "dataConnector.dataPreviewLabel": "Anteprima dati",
  "dataConnector.rowsParsedCount": {
    "one": "{countDisplay} riga analizzata",
    "other": "{countDisplay} righe analizzate",
    "many": "{countDisplay} righe analizzate"
  },
  "dataConnector.sampleRowsCount": {
    "one": "{countDisplay} riga di esempio",
    "other": "{countDisplay} righe di esempio",
    "many": "{countDisplay} righe di esempio"
  },
  "dataConnector.entityMatchingLabel": "Associazione entità",
  "dataConnector.matchByLabel": "Associa per",
  "dataConnector.matchTypeGlobalId": "GlobalId",
  "dataConnector.matchTypeExpressId": "EXPRESS ID",
  "dataConnector.matchTypeEntityName": "Nome dell'entità",
  "dataConnector.matchTypePropertyValue": "Valore della proprietà",
  "dataConnector.csvColumnLabel": "Colonna CSV",
  "dataConnector.selectColumnPlaceholder": "Seleziona colonna",
  "dataConnector.columnSampleHint": "(es. {sample})",
  "dataConnector.propertySetFieldLabel": "Insieme di proprietà",
  "dataConnector.propertySetPlaceholder": "es. Pset_WallCommon",
  "dataConnector.propertyNameFieldLabel": "Nome della proprietà",
  "dataConnector.propertyNamePlaceholder": "es. Reference",
  "dataConnector.propertyMappingsLabel": "Associazioni delle proprietà",
  "dataConnector.autoDetectButton": "Rileva automaticamente",
  "dataConnector.addMappingButton": "Aggiungi",
  "dataConnector.noMappingsText": "Nessuna associazione di proprietà configurata",
  "dataConnector.noMappingsHint": "Fai clic su \"Rileva automaticamente\" o \"Aggiungi\" per associare colonne CSV a proprietà IFC",
  "dataConnector.sourceColumnHeader": "Colonna di origine",
  "dataConnector.targetPsetHeader": "Pset di destinazione",
  "dataConnector.targetPropertyHeader": "Proprietà di destinazione",
  "dataConnector.typeHeader": "Tipo",
  "dataConnector.columnPlaceholder": "Colonna",
  "dataConnector.psetNamePlaceholder": "Nome Pset",
  "dataConnector.propertyPlaceholder": "Proprietà",
  "dataConnector.valueTypeString": "Stringa",
  "dataConnector.valueTypeReal": "Reale",
  "dataConnector.valueTypeInteger": "Intero",
  "dataConnector.valueTypeBoolean": "Booleano",
  "dataConnector.matchResultsTitle": "Risultati delle associazioni",
  "dataConnector.matchedCount": "{countDisplay} associati",
  "dataConnector.unmatchedCount": "{countDisplay} non associati",
  "dataConnector.highConfidenceCount": "{countDisplay} ad alta affidabilità",
  "dataConnector.multiMatchCount": "{countDisplay} con più corrispondenze",
  "dataConnector.phaseParsing": "Analisi CSV...",
  "dataConnector.phaseMatching": "Associazione entità...",
  "dataConnector.phaseApplying": "Applicazione proprietà...",
  "dataConnector.writtenSuffix": " · {countDisplay} scritti",
  "dataConnector.importCompleteTitle": "Importazione completata",
  "dataConnector.propertiesUpdatedCount": {
    "one": "{countDisplay} proprietà aggiornata",
    "other": "{countDisplay} proprietà aggiornate",
    "many": "{countDisplay} proprietà aggiornate"
  },
  "dataConnector.rowsMatchedCount": {
    "one": "{countDisplay} riga associata",
    "other": "{countDisplay} righe associate",
    "many": "{countDisplay} righe associate"
  },
  "dataConnector.rowsUnmatchedCount": {
    "one": "{countDisplay} riga non associata",
    "other": "{countDisplay} righe non associate",
    "many": "{countDisplay} righe non associate"
  },
  "dataConnector.warningsCount": {
    "one": "{countDisplay} avviso",
    "other": "{countDisplay} avvisi",
    "many": "{countDisplay} avvisi"
  },
  "dataConnector.errorTitle": "Errore",
  "dataConnector.previewMatchesButton": "Anteprima delle associazioni",
  "dataConnector.importButton": "Importa",
  "dataConnector.importRowsButton": {
    "one": "Importa {countDisplay} riga",
    "other": "Importa {countDisplay} righe",
    "many": "Importa {countDisplay} righe"
  },
  "dataConnector.removeMappingLabel": "Rimuovi associazione"
} satisfies Catalogue;
