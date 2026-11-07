/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackTablesFr = {
  'assistantSources.lists.description': 'La dernière exécution de liste : ses colonnes, unités, totaux et lignes.',
  'assistantSources.lists.rows': 'Les lignes représentent les éléments retenus par la liste exécutée, avec les valeurs de leurs colonnes.',
  'assistantSources.lists.unavailable': 'Aucun résultat de liste n’était disponible lors de la capture. Exécutez une liste dans le panneau Listes et actualisez les preuves.',
  'assistantSources.lists.suggestSummary': 'Résume cette liste et ses totaux',
  'assistantSources.lists.suggestGaps': 'Quelles lignes ont des valeurs manquantes ?',
  'assistantSources.lists.running': 'Exécution…',
  'assistantSources.lists.ready': { one: '{count} ligne', many: '{count} de lignes', other: '{count} lignes' },
  'assistantSources.lists.notRun': 'Aucune liste exécutée pour l’instant',
  'assistantSources.charts.title': 'Graphiques',
  'assistantSources.charts.description': 'Le tableau de bord actif : les catégories et valeurs de chaque graphique, et ce qui n’a pas pu être placé.',
  'assistantSources.charts.rows': 'Les lignes représentent les catégories des graphiques, chacune avec son graphique, sa valeur, son compte et son unité.',
  'assistantSources.charts.unavailable': 'Aucun tableau de bord de graphiques n’était disponible lors de la capture. Ouvrez le panneau Graphiques et actualisez les preuves.',
  'assistantSources.charts.suggestSummary': 'Qu’est-ce qui ressort de ces graphiques ?',
  'assistantSources.charts.suggestGaps': 'Quels éléments n’ont pas pu être représentés, et pourquoi ?',
  'assistantSources.charts.ready': { one: '{count} graphique', many: '{count} de graphiques', other: '{count} graphiques' },
  'assistantSources.charts.noDashboard': 'Aucun tableau de bord pour l’instant',
  'assistantSources.charts.noCharts': 'Le tableau de bord ne contient aucun graphique',
  'assistantSources.cost.description': 'Postes de coût de chaque modèle chargé, avec montants évalués, devises et diagnostics.',
  'assistantSources.cost.rows': 'Les lignes représentent des entrées IfcCostItem avec leur montant évalué, leur devise et leurs diagnostics.',
  'assistantSources.cost.unavailable': 'Aucune source de coûts n’était disponible lors de la capture. Chargez un modèle IFC pour lire ses données de coûts.',
  'assistantSources.cost.suggestSummary': 'Résume les totaux des coûts par devise',
  'assistantSources.cost.suggestGaps': 'Quels postes de coût n’ont pas de montant, et pourquoi ?',
  'assistantSources.cost.ready': { one: '{count} modèle avec une source de coûts', many: '{count} de modèles avec une source de coûts', other: '{count} modèles avec une source de coûts' },
  'assistantSources.cost.noSource': 'Aucune source IFC dans laquelle lire les coûts',
} satisfies Catalogue;
