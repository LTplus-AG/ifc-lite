/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackTablesIt = {
  'assistantSources.lists.description': 'L’ultima esecuzione di elenco: colonne, unità, totali e righe.',
  'assistantSources.lists.rows': 'Le righe rappresentano gli elementi trovati dall’elenco eseguito, con i valori delle colonne.',
  'assistantSources.lists.unavailable': 'Al momento dell’acquisizione non era disponibile alcun risultato di elenco. Esegui un elenco nel pannello Elenchi e aggiorna le evidenze.',
  'assistantSources.lists.suggestSummary': 'Riassumi questo elenco e i suoi totali',
  'assistantSources.lists.suggestGaps': 'Quali righe hanno valori mancanti?',
  'assistantSources.lists.running': 'Esecuzione in corso…',
  'assistantSources.lists.ready': { one: '{count} riga', many: '{count} righe', other: '{count} righe' },
  'assistantSources.lists.notRun': 'Nessun elenco ancora eseguito',
  'assistantSources.charts.title': 'Grafici',
  'assistantSources.charts.description': 'La dashboard attiva: intervalli e valori di ogni grafico, e ciò che non è stato possibile collocare.',
  'assistantSources.charts.rows': 'Le righe rappresentano gli intervalli dei grafici, ciascuno con grafico, valore, conteggio e unità.',
  'assistantSources.charts.unavailable': 'Al momento dell’acquisizione non era disponibile alcuna dashboard di grafici. Apri il pannello Grafici e aggiorna le evidenze.',
  'assistantSources.charts.suggestSummary': 'Cosa risalta in questi grafici?',
  'assistantSources.charts.suggestGaps': 'Quali elementi non è stato possibile rappresentare nei grafici, e perché?',
  'assistantSources.charts.ready': { one: '{count} grafico', many: '{count} grafici', other: '{count} grafici' },
  'assistantSources.charts.noDashboard': 'Nessuna dashboard ancora',
  'assistantSources.charts.noCharts': 'La dashboard non contiene grafici',
  'assistantSources.cost.description': 'Voci di costo di ogni modello caricato, con importi valutati, valute e diagnostica.',
  'assistantSources.cost.rows': 'Le righe rappresentano voci IfcCostItem con importo valutato, valuta e diagnostica.',
  'assistantSources.cost.unavailable': 'Al momento dell’acquisizione non era disponibile alcuna origine dei costi. Carica un modello IFC per leggerne i dati di costo.',
  'assistantSources.cost.suggestSummary': 'Riassumi i totali dei costi per valuta',
  'assistantSources.cost.suggestGaps': 'Quali voci di costo non hanno un importo, e perché?',
  'assistantSources.cost.ready': {
    one: '{count} modello con un’origine dei costi',
    many: '{count} modelli con un’origine dei costi',
    other: '{count} modelli con un’origine dei costi',
  },
  'assistantSources.cost.noSource': 'Nessuna origine IFC da cui leggere i costi',
} satisfies Catalogue;
