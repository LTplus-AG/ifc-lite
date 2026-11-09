/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackAutomationIt = {
  "assistantSources.flowRun.title": "Esecuzione Flow",
  "assistantSources.flowRun.description": "L'ultima esecuzione del grafo aperto: risultati dei nodi, avvisi, output e artefatti.",
  "assistantSources.flowRun.rows": "Le righe mostrano prima i risultati dei nodi non riusciti (con archi in ingresso e parametri solo per i nodi non riusciti e quelli che li alimentano, senza codice degli script e con credenziali oscurate), poi avvisi di esecuzione, artefatti (solo metadati), output del grafo, risultati degli altri nodi e voci di registro.",
  "assistantSources.flowRun.unavailable": "Nessun risultato di esecuzione Flow era disponibile all'acquisizione. Esegui il grafo in Flow e aggiorna le evidenze.",
  "assistantSources.flowRun.discussRun": "Discuti l'esecuzione con l'IA",
  "assistantSources.flowRun.suggestExplain": "Spiega cosa ha fatto questa esecuzione e cosa ha prodotto",
  "assistantSources.flowRun.suggestFix": "Perché alcuni nodi non sono riusciti o hanno generato avvisi, e come posso correggerli?",
  "assistantSources.flowRun.statusRunning": "Esecuzione…",
  "assistantSources.flowRun.statusOk": {
    "one": "Riuscita · {count} nodo",
    "other": "Riuscita · {count} nodi",
    "many": "Riuscita · {count} nodi"
  },
  "assistantSources.flowRun.statusFailed": {
    "one": "Non riuscita · {count} nodo",
    "other": "Non riuscita · {count} nodi",
    "many": "Non riuscita · {count} nodi"
  },
  "assistantSources.flowRun.statusError": "Esecuzione non riuscita prima di produrre un risultato",
  "assistantSources.flowRun.statusNone": "Nessuna esecuzione finora",
  "assistantSources.script.description": "L'ultima esecuzione dello script: valore restituito, diagnostica e output della console.",
  "assistantSources.script.rows": "Le righe mostrano il valore restituito, la diagnostica e le voci di registro. Il codice dello script è escluso.",
  "assistantSources.script.unavailable": "Nessuna esecuzione di script era disponibile all'acquisizione. Esegui uno script nell'editor degli script e aggiorna le evidenze.",
  "assistantSources.script.suggestExplain": "Spiega cosa ha restituito e registrato questa esecuzione dello script",
  "assistantSources.script.suggestFix": "Perché questo script non è riuscito, e come posso correggerlo?",
  "assistantSources.script.statusRunning": "Esecuzione…",
  "assistantSources.script.statusError": "Ultima esecuzione non riuscita",
  "assistantSources.script.statusResult": {
    "one": "Ultima esecuzione · {count} voce di registro",
    "other": "Ultima esecuzione · {count} voci di registro",
    "many": "Ultima esecuzione · {count} voci di registro"
  },
  "assistantSources.script.statusDiagnostics": {
    "one": "{count} messaggio diagnostico",
    "other": "{count} messaggi diagnostici",
    "many": "{count} messaggi diagnostici"
  },
  "assistantSources.script.statusNone": "Nessuna esecuzione finora",
  "assistantSources.document.description": "I blocchi, i collegamenti ai dati e le impostazioni di pagina del documento aperto.",
  "assistantSources.document.rows": "Le righe mostrano i blocchi del documento in ordine. Il testo è il modello non risolto; immagini e grafici sono solo metadati.",
  "assistantSources.document.unavailable": "Nessun documento era aperto all'acquisizione. Apri un documento e aggiorna le evidenze.",
  "assistantSources.document.suggestReview": "Esamina la struttura di questo documento e suggerisci miglioramenti",
  "assistantSources.document.suggestBindings": "A quali campi del modello fa riferimento questo documento?",
  "assistantSources.document.status": {
    "one": "{name} · {count} blocco",
    "other": "{name} · {count} blocchi",
    "many": "{name} · {count} blocchi"
  },
  "assistantSources.document.statusNone": "Nessun documento aperto"
} satisfies Catalogue;
