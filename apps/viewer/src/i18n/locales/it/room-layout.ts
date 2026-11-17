/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const roomLayoutIt = {
  'roomLayout.mode.edit': 'Modifica',
  'roomLayout.tool.label': 'Cosa fa un clic sulla disposizione',
  'roomLayout.tool.shape': 'Sposta · Taglia',
  'roomLayout.tool.remove': 'Unisci · Rimuovi',
  'roomLayout.tool.shapeTitle': 'Trascina un vertice per spostarlo; fai clic su due punti del contorno di un locale per tagliare il locale tra di essi',
  'roomLayout.tool.removeTitle': 'Fai clic sul muro tra due locali per unirli; fai clic su un vertice per rimuoverlo',
  'roomLayout.cleanup.label': 'Pulisci',
  'roomLayout.cleanup.title': 'Rimuovi dalla disposizione muri pendenti, nodi isolati e vertici superflui, in un solo passo di annullamento',
  'roomLayout.hint.shape': 'Trascina un vertice per spostarlo · fai clic sul contorno di un locale per iniziare un taglio',
  'roomLayout.hint.remove': 'Fai clic sul muro tra due locali per unirli, o su un vertice per rimuoverlo',
  'roomLayout.hint.drop': 'Rilascia, o fai clic, per posare il vertice · Esc annulla',
  'roomLayout.hint.cutEnd': 'Fai clic su un altro punto dello stesso contorno del locale per tagliarlo · Esc annulla',
  'roomLayout.hint.open': 'Nessun muro chiude quest’area: le estremità aperte dei muri sono evidenziate',
  'roomLayout.edit.none': 'Punta prima un vertice o il contorno di un locale',
  'roomLayout.edit.refused': 'La disposizione non può accettare questa modifica: {reason}',
  'roomLayout.prune.none': 'Niente da pulire: la disposizione non ha muri o nodi isolati',
  'roomLayout.refused.shape': 'Un locale qui non è un contorno estruso in verticale, quindi la sua forma non può essere modificata: usa Aggiorna locali o ridisegnalo',
  'roomLayout.refused.storey': 'Un locale qui non si trova su un piano, quindi la sua forma non può essere modificata',
  'roomLayout.refused.merge': 'Non è stato possibile rimuovere uno dei locali uniti',
  'roomLayout.more.label': 'Altro',
  'roomLayout.more.title': 'Impronta, Automatico su ogni piano, saldatura dei vertici e diagnostica dei varchi',
  'roomLayout.footprint.label': 'Impronta',
  'roomLayout.footprint.title': 'Un unico locale sull’intero contorno di questo piano, in un solo passo di annullamento',
  'roomLayout.footprint.taken': 'Questo piano ha già dei locali: Impronta crea un unico locale sull’intero piano, che quindi li sovrapporrebbe',
  'roomLayout.autoAll.label': 'Automatico su ogni piano',
  'roomLayout.autoAll.title': 'Trasforma in locale ogni area chiusa da muri che non ha ancora un locale, su ogni piano, in un solo passo di annullamento',
  'roomLayout.autoAll.none': 'Ogni area chiusa da muri su ogni piano ha già un locale',
  'roomLayout.weld.label': 'Saldatura dei vertici',
  'roomLayout.weld.title': 'Quanto devono essere vicini due vertici di muro per contare come uno solo: aumentala quando muri che si incontrano lasciano un locale aperto',
  'roomLayout.weld.aria': 'Saldatura dei vertici (metri)',
  'roomLayout.weld.auto': 'Predefinita (5 cm)',
  'roomLayout.weld.reset': 'Ripristina il valore predefinito di 5 cm',
  'roomLayout.weld.rooms': {
    one: '{countDisplay} locale',
    many: '{countDisplay} locali',
    other: '{countDisplay} locali',
  },
  'roomLayout.leaks.label': 'Mostra varchi',
  'roomLayout.leaks.title': 'Evidenzia i muri che non racchiudono alcun locale e le estremità di muro che non toccano nulla: il motivo per cui un’area non è chiusa',
} satisfies Catalogue;
