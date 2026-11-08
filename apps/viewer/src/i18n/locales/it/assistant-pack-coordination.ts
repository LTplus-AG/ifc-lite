/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackCoordinationIt = {
  "assistantSources.changes.description": "Modifiche nella cronologia di annullamento di questa sessione, per operazione e modello.",
  "assistantSources.changes.rows": "Le righe rappresentano singole modifiche delle operazioni attive, a partire dall'operazione più recente.",
  "assistantSources.changes.unavailable": "Nessun modello caricato, quindi non esiste una cronologia delle modifiche da allegare.",
  "assistantSources.changes.ready": {
    "one": "{count} modifica",
    "other": "{count} modifiche",
    "many": "{count} modifiche"
  },
  "assistantSources.changes.none": "Nessuna modifica finora",
  "assistantSources.changes.suggestSummary": "Riassumi cosa è stato modificato e in quali modelli",
  "assistantSources.changes.suggestReview": "Quali modifiche dovrei esaminare prima di esportare?",
  "assistantSources.changeSets.description": "Gruppi di modifiche con un nome: dimensioni, modelli e tipi di modifica.",
  "assistantSources.changeSets.rows": "Le righe rappresentano insiemi di modifiche (solo metadati, senza valori delle modifiche né contenuti dei file).",
  "assistantSources.changeSets.unavailable": "Non esiste alcun insieme di modifiche. Creane uno nel pannello Insiemi di modifiche.",
  "assistantSources.changeSets.ready": {
    "one": "{count} insieme di modifiche",
    "other": "{count} insiemi di modifiche",
    "many": "{count} insiemi di modifiche"
  },
  "assistantSources.changeSets.none": "Nessun insieme di modifiche",
  "assistantSources.changeSets.suggestSummary": "Riassumi cosa contiene ciascun insieme di modifiche",
  "assistantSources.schedule.description": "Attività del programma 4D con date, traguardi ed elementi assegnati.",
  "assistantSources.schedule.rows": "Le righe rappresentano attività del programma. Le date mancanti sono null, non stimate.",
  "assistantSources.schedule.unavailable": "Nessun programma caricato. Apri il pannello Programma per leggere i dati IfcTask, oppure genera o importa un programma.",
  "assistantSources.schedule.ready": {
    "one": "{count} attività",
    "other": "{count} attività",
    "many": "{count} attività"
  },
  "assistantSources.schedule.none": "Nessun programma",
  "assistantSources.schedule.suggestSummary": "Riassumi il programma: fasi, traguardi e durata complessiva",
  "assistantSources.schedule.suggestGaps": "Quali attività non hanno date o elementi assegnati?",
  "assistantSources.semantic.description": "Record collegati, la loro risoluzione in elementi del modello, rilievi di validazione e testi delle specifiche allegati.",
  "assistantSources.semantic.rows": "Le righe rappresentano prima i passaggi di testo allegati con posizioni esatte, poi i record collegati con la loro risoluzione e infine i rilievi di validazione.",
  "assistantSources.semantic.unavailable": "Nessun record collegato caricato né testo allegato. Carica record o allega un testo nel pannello Record collegati.",
  "assistantSources.semantic.ready": {
    "one": "{count} record · {findings} rilievi",
    "other": "{count} record · {findings} rilievi",
    "many": "{count} record · {findings} rilievi"
  },
  "assistantSources.semantic.none": "Nessun record caricato",
  "assistantSources.semantic.suggestUnresolved": "Quali record non si risolvono in un elemento del modello, e perché?",
  "assistantSources.semantic.suggestFindings": "Spiega i rilievi di validazione",
  "assistantSources.review.description": "Una scheda di coordinamento dello spazio Revisione: rilievi di più analisi sugli stessi elementi validati.",
  "assistantSources.review.rows": "Le righe rappresentano i rilievi nella scheda, ciascuno con l'analisi di origine, lo stato nativo e l'indicazione se l'esecuzione è attuale, storica o parziale.",
  "assistantSources.review.unavailable": "Nessuna scheda fissata. Scegli Chiedi informazioni su questa scheda da una scheda nello spazio Revisione.",
  "assistantSources.review.ready": {
    "one": "{count} rilievo nella scheda fissata",
    "other": "{count} rilievi nella scheda fissata",
    "many": "{count} rilievi nella scheda fissata"
  },
  "assistantSources.review.none": "Nessuna scheda fissata",
  "assistantSources.review.suggestExplain": "Perché questi rilievi indicano gli stessi elementi?",
  "assistantSources.review.suggestNext": "Cosa controllerebbe dopo un coordinatore in questa scheda?"
} satisfies Catalogue;
