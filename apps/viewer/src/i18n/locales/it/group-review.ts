/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const groupReviewIt = {
  'groupReview.title': 'Rivedi le modifiche ai gruppi',
  'groupReview.hint': 'Seleziona le modifiche, poi rivedi i nomi dei gruppi e l’appartenenza completa. La rimozione di un gruppo conserva i suoi membri e le loro altre appartenenze.',
  'groupReview.prepare': 'Rivedi le modifiche ai gruppi selezionate',
  'groupReview.acknowledgement': 'Ho rivisto l’appartenenza completa e i riferimenti condivisi.',
  'groupReview.population': 'Record nativi: {created} creati · {modified} modificati · {deleted} eliminati',
  'groupReview.nativeChanges': 'Esamina le modifiche ai gruppi e i riferimenti condivisi',
  'groupReview.receiptProblem': 'Le modifiche sono state applicate, ma non è stato possibile salvarne la ricevuta. L’annullamento resta disponibile nella cronologia delle modifiche.',
  'groupReview.op.group.create': 'Crea gruppo',
  'groupReview.op.group.update': 'Aggiorna il gruppo e sostituisci l’appartenenza completa',
  'groupReview.op.group.remove': 'Rimuovi gruppo',
} satisfies Catalogue;
