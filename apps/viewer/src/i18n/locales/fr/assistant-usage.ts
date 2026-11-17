/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantUsageFr = {
  'assistantUsage.receiptTokens': '{input} → {output} jetons · {seconds} s',
  'assistantUsage.receiptUnreported': 'Utilisation non communiquée · {seconds} s',
  'assistantUsage.freeRemaining': 'Requêtes gratuites restantes : {remaining} sur {limit}',
  'assistantUsage.freeChecking': 'Requêtes gratuites restantes : vérification…',
  'assistantUsage.freeUnknown': 'Requêtes gratuites restantes : inconnu',
  'assistantUsage.budgetExhausted': 'Cette conversation a épuisé son budget de requêtes. Actualisez les preuves pour démarrer une nouvelle conversation.',
} satisfies Catalogue;
