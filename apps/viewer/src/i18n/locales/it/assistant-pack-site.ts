/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackSiteIt = {
  'assistantSources.zones.description': 'In quale zona ricade ogni elemento, con il volume della mesh per zona e il motivo quando un volume manca',
  'assistantSources.zones.rows': 'Ogni riga è un elemento in una zona che raggiunge, con la sua quota di volume',
  'assistantSources.zones.unavailable': 'Nessuna assegnazione alle zone disponibile. Crea prima un insieme di zone e lascia che gli elementi vengano assegnati.',
  'assistantSources.zones.suggestSummary': 'Riassumi come gli elementi sono distribuiti tra le zone',
  'assistantSources.zones.suggestUnmeasured': 'Quali elementi non hanno un volume misurato, e perché?',
  'assistantSources.zones.noSets': 'Nessun insieme di zone',
  'assistantSources.zones.notAssigned': 'Elementi non ancora assegnati',
  'assistantSources.zones.ready': { one: '{count} insieme di zone', many: '{count} insiemi di zone', other: '{count} insiemi di zone' },
  'assistantSources.placement.description': 'Spostamento e orientamento di ogni modello nello spazio di lavoro, la sua georeferenziazione ed eventuali doppie georeferenziazioni',
  'assistantSources.placement.rows': 'Ogni riga è un modello caricato con il suo posizionamento e la sua georeferenziazione',
  'assistantSources.placement.unavailable': 'Nessun modello è caricato, quindi non c’è alcun posizionamento da discutere.',
  'assistantSources.placement.suggestAlignment': 'I modelli caricati sono posizionati in modo coerente tra loro?',
  'assistantSources.placement.suggestGeoref': 'Spiega la georeferenziazione di ogni modello e tutto ciò che sembra errato',
  'assistantSources.layerDiff.title': 'Modifiche del layer',
  'assistantSources.layerDiff.description': 'Ciò che un layer IFCX aggiunge, modifica ed elimina nello stack composto',
  'assistantSources.layerDiff.rows': 'Ogni riga è un percorso che il layer ha aggiunto, modificato o eliminato',
  'assistantSources.layerDiff.unavailable': 'Nessun confronto tra layer è stato calcolato. Apri prima le modifiche di un layer nel pannello Layer.',
  'assistantSources.layerDiff.suggestSummary': 'Riassumi cosa modifica questo layer',
  'assistantSources.layerDiff.suggestReview': 'Cosa dovrebbe controllare un revisore prima di accettare questo layer?',
  'assistantSources.layerDiff.noStack': 'Nessuno stack di layer caricato',
  'assistantSources.layerDiff.running': 'Calcolo delle modifiche del layer',
  'assistantSources.layerDiff.notRun': 'Nessuna modifica di layer aperta',
  'assistantSources.layerDiff.ready': { one: '{count} modifica', many: '{count} modifiche', other: '{count} modifiche' },
  'assistantSources.selection.title': 'Selezione',
  'assistantSources.selection.description': 'Gli elementi selezionati con attributi, set di proprietà e quantità, modifiche incluse',
  'assistantSources.selection.rows': 'Ogni riga è un elemento selezionato come lo mostra il pannello Proprietà',
  'assistantSources.selection.unavailable': 'Nessuna selezione. Seleziona prima uno o più elementi.',
  'assistantSources.selection.suggestExplain': 'Spiega cosa è selezionato e cosa c’è di notevole',
  'assistantSources.selection.suggestCompare': 'In cosa differiscono tra loro gli elementi selezionati?',
  'assistantSources.selection.none': 'Nessuna selezione',
  'assistantSources.selection.ready': {
    one: '{count} elemento selezionato',
    many: '{count} elementi selezionati',
    other: '{count} elementi selezionati',
  },
} satisfies Catalogue;
