/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const costReviewIt = {
  'costReview.title': 'Rivedi i costi forniti',
  'costReview.hint': 'Rivedi solo gli importi forniti e le unità native. Nessun prezzo, tariffa o valuta viene dedotto. Seleziona le operazioni, poi esamina le modifiche native complete prima di Applica.',
  'costReview.prepare': 'Rivedi le operazioni di costo selezionate',
  'costReview.references': 'Destinazione nativa: {target} · record correlati: {related}',
  'costReview.detach': 'Scollega i riferimenti condivisi secondo le regole native di rimozione. Esamina qui sotto tutti i record modificati ed eliminati.',
  'costReview.population': '{records} record di origine rivisti · {created} creati · {modified} modificati · {deleted} eliminati. Le identità IFC create vengono assegnate al momento di Applica.',
  'costReview.nativeChanges': 'Esamina le modifiche IFC native, inclusi riferimenti condivisi ed eliminazioni',
  'costReview.receiptProblem': 'Le modifiche sono state applicate, ma non è stato possibile salvarne la ricevuta. La cronologia nativa delle modifiche contiene comunque le modifiche.',
  'costReview.op.cost.schedule.create': 'Crea computo dei costi',
  'costReview.op.cost.item.create': 'Crea voce di costo',
  'costReview.op.cost.value.create': 'Crea valore di costo fornito',
  'costReview.op.cost.quantity.create': 'Crea quantità fornita',
  'costReview.op.cost.items.nest': 'Annida voci di costo',
  'costReview.op.cost.schedule.assign': 'Assegna voci al computo',
  'costReview.op.cost.item.assign': 'Assegna oggetti alla voce di costo',
  'costReview.op.cost.item.values': 'Sostituisci i valori di costo della voce',
  'costReview.op.cost.remove': 'Rimuovi record di costo',
} satisfies Catalogue;
