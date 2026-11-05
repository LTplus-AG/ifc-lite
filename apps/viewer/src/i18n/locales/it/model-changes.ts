/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const modelChangesIt = {
  "modelChanges.commandLabel": "Applica modifiche revisionate",
  "modelChanges.title": "Revisiona modifiche al modello",
  "modelChanges.rows": "Modifiche proposte",
  "modelChanges.counts": "{ready} pronte · {conflict} richiedono attenzione · {unchanged} invariate o non supportate",
  "modelChanges.status.ready": "Pronta",
  "modelChanges.status.unchanged": "Già impostato",
  "modelChanges.status.conflict": "Valore modificato",
  "modelChanges.status.missing": "Elemento non trovato",
  "modelChanges.status.ambiguous": "Elemento in più modelli",
  "modelChanges.status.denied": "Non modificabile",
  "modelChanges.status.unsupported": "Valore non supportato",
  "modelChanges.approveRow": "Applica {field} su {element}",
  "modelChanges.absent": "(vuoto)",
  "modelChanges.removed": "(rimosso)",
  "modelChanges.expectedWas": "La proposta prevedeva {value}; nel frattempo il modello è cambiato.",
  "modelChanges.showElement": "Mostra elemento nel modello",
  "modelChanges.editModeRequired": "Le modifiche vengono applicate con i normali strumenti di modifica, quindi la modalità Modifica deve essere attiva.",
  "modelChanges.turnOnEditMode": "Attiva modalità Modifica",
  "modelChanges.apply": {
    "one": "Applica {count} modifica",
    "other": "Applica {count} modifiche",
    "many": "Applica {count} modifiche"
  },
  "modelChanges.refused.stale": "Il modello è cambiato durante la revisione. Controlla gli stati aggiornati e applica di nuovo.",
  "modelChanges.refused.nothing-approved": "Seleziona almeno una modifica pronta.",
  "modelChanges.refused.refused": "Il modello ha rifiutato le modifiche; non è stato applicato nulla.",
  "modelChanges.receiptApplied": {
    "one": "Applicata {count} modifica come unico passaggio annullabile",
    "other": "Applicate {count} modifiche come unico passaggio annullabile",
    "many": "Applicate {count} modifiche come unico passaggio annullabile"
  },
  "modelChanges.receiptUndone": {
    "one": "Annullata {count} modifica",
    "other": "Annullate {count} modifiche",
    "many": "Annullate {count} modifiche"
  },
  "modelChanges.receiptDetail": "{batches} gruppi di modifiche al modello · {skipped} saltati. Elencati in Modifiche e annullabili con Ctrl+Z.",
  "modelChanges.undo": "Annulla queste modifiche",
  "modelChanges.undoRefused.stale": "Queste modifiche non sono più in cima alla cronologia.",
  "modelChanges.undoRefused.newer-conflict": "Modifiche più recenti hanno cambiato gli stessi valori. Annulla prima quelle.",
  "modelChanges.undoRefused.shared-room": "Le modifiche in una sessione condivisa vengono annullate dal loro autore dal pannello Modifiche.",
  "modelChanges.undoRefused.missing-view": "Il modello non è più caricato.",
  "modelChanges.undoRefused.unsupported": "Questa modifica non può essere annullata automaticamente.",
  "modelChanges.undoRefused.not-in-history": "La cronologia non contiene più queste modifiche (ad esempio dopo un ricaricamento).",
  "modelChanges.undoRefused.already-undone": "Queste modifiche sono già state annullate.",
  "modelChanges.undoRefused.edit-mode": "Attiva la modalità Modifica per annullare.",
  "modelChanges.undoRefused.workflow-running": "Attendi che il flusso di lavoro in esecuzione termini.",
  "modelChanges.undoRefused.collab-role": "Il tuo ruolo nella sessione non può modificare questo modello.",
  "modelChanges.undoRefused.model-unavailable": "Il modello non è più caricato.",
  "modelChanges.receiptsTitle": "Modifiche revisionate",
  "modelChanges.receiptsEmpty": "Nessun gruppo di modifiche revisionate finora.",
  "assistant.proposalChanges": "Proposta di modifica al modello",
  "assistant.proposalChangesSummary": {
    "one": "{count} modifica proposta",
    "other": "{count} modifiche proposte",
    "many": "{count} modifiche proposte"
  },
  "assistant.suggestValidationCorrections": "Prepara correzioni per i requisiti non soddisfatti"
} satisfies Catalogue;
