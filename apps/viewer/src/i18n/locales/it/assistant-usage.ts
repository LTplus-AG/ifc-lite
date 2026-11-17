/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantUsageIt = {
  'assistantUsage.receiptTokens': '{input} → {output} token · {seconds} s',
  'assistantUsage.receiptUnreported': 'Utilizzo non comunicato · {seconds} s',
  'assistantUsage.freeRemaining': 'Richieste gratuite rimanenti: {remaining} di {limit}',
  'assistantUsage.freeChecking': 'Richieste gratuite rimanenti: verifica in corso…',
  'assistantUsage.freeUnknown': 'Richieste gratuite rimanenti: sconosciute',
  'assistantUsage.budgetExhausted': 'Questa conversazione ha esaurito il budget di richieste. Aggiorna le evidenze per avviare una nuova conversazione.',
} satisfies Catalogue;
