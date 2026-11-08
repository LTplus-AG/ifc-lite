/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const semanticResultsIt = {
  "semantic.resultsSelectAll": "Seleziona tutti i risultati associati",
  "semantic.resultsClear": "Cancella selezione",
  "semantic.resultsSelection": "Selezione",
  "semantic.resultsToggle": "Seleziona o deseleziona la riga di risultato {row}",
  "semantic.resultsSelectionHelp": "Le caselle aggiungono o rimuovono le entità associate. Seleziona tutto include ogni pagina e salta le righe non risolte o ambigue. Ctrl/Cmd-clic su un'associazione per aggiungere o rimuovere un candidato.",
  "semantic.resultsTitle": "Risultati SPARQL",
  "semantic.resultsPrevious": "Righe precedenti",
  "semantic.resultsNext": "Righe successive",
  "semantic.resultsPage": "Righe {start}–{end} di {count}",
  "semantic.resultsUnbound": "Non associato",
  "semantic.resultsSelect": "Seleziona riga associata",
  "semantic.resultsCandidates": "Scegli un candidato del modello",
  "semantic.resultsChoose": "Seleziona {model}, entità {id}",
  "semantic.resultsStatus": "Associazione IFC",
  "semantic.resultsResolved": "Risolto",
  "semantic.resultsAmbiguous": "Ambiguo",
  "semantic.resultsUnmatched": "Senza corrispondenza",
  "semantic.resultsUnscoped": "Revisione non associata",
  "semantic.resultsExternal": "Nessuna identità IFC",
  "semantic.resultsInvalid": "Identità non valida",
  "semantic.resultsStale": "Il candidato non è più disponibile; risolvi di nuovo la riga"
} satisfies Catalogue;
