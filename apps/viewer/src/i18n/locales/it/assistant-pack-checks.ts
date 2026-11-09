/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackChecksIt = {
  "assistantSources.duplicates.title": "Elementi duplicati",
  "assistantSources.duplicates.description": "Gruppi di copie coincidenti o sovrapposte rilevati dalla ricerca dei duplicati.",
  "assistantSources.duplicates.rows": "Ogni riga è un gruppo di elementi coincidenti, non una coppia.",
  "assistantSources.duplicates.unavailable": "Nessun risultato della ricerca dei duplicati era disponibile all'acquisizione. Esegui Trova duplicati in Rilevamento interferenze e aggiorna le evidenze.",
  "assistantSources.duplicates.suggestSummary": "Riassumi i gruppi di duplicati e i tipi di elementi coinvolti",
  "assistantSources.duplicates.suggestCleanup": "Quali gruppi di duplicati sembrano copie esatte da rimuovere per prime?",
  "assistantSources.duplicates.pickSets": {
    "one": "{count} gruppo di duplicati",
    "other": "{count} gruppi di duplicati",
    "many": "{count} gruppi di duplicati"
  },
  "assistantSources.manualChecklist.title": "Lista di controllo manuale",
  "assistantSources.manualChecklist.description": "La lista di controllo manuale aperta e gli esiti registrati dai revisori per ciascun modello caricato.",
  "assistantSources.manualChecklist.rows": "Ogni riga è una voce della lista di controllo per un modello, con l'esito del revisore oppure ancora senza esito.",
  "assistantSources.manualChecklist.unavailable": "Nessuna lista di controllo manuale era aperta all'acquisizione. Aprine o creane una in Validazione dati e aggiorna le evidenze.",
  "assistantSources.manualChecklist.suggestSummary": "Riassumi l'avanzamento della lista di controllo e le voci con esito negativo",
  "assistantSources.manualChecklist.suggestOpen": "Quali voci sono ancora senza risposta, e cosa va controllato dopo?",
  "assistantSources.manualChecklist.pickItems": {
    "one": "{count} voce",
    "other": "{count} voci",
    "many": "{count} voci"
  },
  "assistantSources.manualChecklist.pickNone": "Nessuna lista di controllo aperta",
  "assistantSources.lens.description": "Quanti elementi soddisfano ogni regola della Lens attiva, con esempi.",
  "assistantSources.lens.rows": "Ogni riga è una regola Lens o un valore di colorazione, con il relativo conteggio nativo delle corrispondenze.",
  "assistantSources.lens.unavailable": "Nessuna Lens valutata era attiva all'acquisizione. Attiva una Lens e aggiorna le evidenze.",
  "assistantSources.lens.suggestSummary": "Spiega cosa mostra la Lens attiva e quali regole corrispondono al maggior numero di elementi",
  "assistantSources.lens.pickRules": {
    "one": "{name} · {count} regola",
    "other": "{name} · {count} regole",
    "many": "{name} · {count} regole"
  },
  "assistantSources.lens.pickNone": "Nessuna Lens attiva",
  "assistantSources.lens.pickPending": "Valutazione…",
  "assistantSources.bcf.description": "Argomenti del progetto BCF caricato: stato, priorità, assegnazione ed elementi referenziati.",
  "assistantSources.bcf.rows": "Ogni riga è un argomento BCF. Il testo dei commenti e le istantanee non sono inclusi.",
  "assistantSources.bcf.unavailable": "Nessun progetto BCF era caricato all'acquisizione. Apri o crea argomenti BCF e aggiorna le evidenze.",
  "assistantSources.bcf.suggestSummary": "Riassumi gli argomenti aperti per stato e priorità",
  "assistantSources.bcf.suggestPriorities": "Quali argomenti vanno risolti per primi, e a chi sono assegnati?",
  "assistantSources.bcf.pickTopics": {
    "one": "{count} argomento",
    "other": "{count} argomenti",
    "many": "{count} argomenti"
  },
  "assistantSources.bcf.pickNone": "Nessun progetto BCF"
} satisfies Catalogue;
