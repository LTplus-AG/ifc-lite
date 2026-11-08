/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const customGroupingFr = {
  "customGrouping.pickGroupingAriaLabel": "Choisir un regroupement personnalisé",
  "customGrouping.pickGroupingPlaceholder": "Choisir un regroupement…",
  "customGrouping.noGroupingsYet": "Aucun regroupement personnalisé pour le moment. Créez d’abord une lentille à règles avec des règles nommées.",
  "customGrouping.unresolvedGrouping": "Le regroupement « {name} » n’existe pas ici. La règle ne correspond à rien tant que vous n’en choisissez pas un autre ou ne l’importez pas.",
  "customGrouping.unresolvedGroups": {"one":"Le groupe {names} ne fait pas partie de ce regroupement. La règle ne correspond à rien tant que le problème n’est pas corrigé.","other":"Les groupes {names} ne font pas partie de ce regroupement. La règle ne correspond à rien tant que le problème n’est pas corrigé.","many":"Les groupes {names} ne font pas partie de ce regroupement. La règle ne correspond à rien tant que le problème n’est pas corrigé."},
} satisfies Catalogue;
