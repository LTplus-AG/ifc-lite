/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const filterGroupsFr = {
  "filterGroups.addGroup": "Ajouter un groupe",
  "filterGroups.addGroupTitle": "Ajouter un autre groupe OU (« + » dans le texte du sélecteur)",
  "filterGroups.tabsAriaLabel": "Groupes de filtres",
  "filterGroups.groupLabel": "Groupe {index}",
  "filterGroups.removeGroupAriaLabel": "Supprimer le groupe {index}",
  "filterGroups.noRules": "Aucune règle : ajoutez-en une pour exécuter.",
  "filterGroups.ruleCount": { one: "{count} règle", other: "{count} règles", many: "{count} de règles" },
  "filterGroups.groupCountOr": { one: "{count} groupe (OU)", other: "{count} groupes (OU)", many: "{count} de groupes (OU)" },
  "filterGroups.limit": "limite",
  "filterGroups.readbackTitle": "Le filtre actuel, sous forme de texte de sélecteur ; un deuxième groupe (Ajouter un groupe, ci-dessous) apparaît ici, relié par « + ».",
} satisfies Catalogue;
