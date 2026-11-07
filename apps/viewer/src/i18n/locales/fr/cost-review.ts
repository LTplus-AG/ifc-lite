/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const costReviewFr = {
  'costReview.title': 'Vérifier les coûts fournis',
  'costReview.hint': 'Vérifiez uniquement les montants fournis et les unités natives. Aucun prix, taux ni devise n’est déduit. Sélectionnez des opérations, puis examinez l’ensemble des modifications natives avant d’appliquer.',
  'costReview.prepare': 'Vérifier les opérations de coût sélectionnées',
  'costReview.references': 'Cible native : {target} · enregistrements liés : {related}',
  'costReview.detach': 'Détacher les références partagées selon les règles de suppression natives. Examinez ci-dessous tous les enregistrements modifiés et supprimés.',
  'costReview.population': '{records} enregistrements source vérifiés · {created} créés · {modified} modifiés · {deleted} supprimés. Les identités IFC créées sont attribuées lors de l’application.',
  'costReview.nativeChanges': 'Examiner les modifications IFC natives, y compris les références partagées et les suppressions',
  'costReview.receiptProblem': 'Les modifications ont été appliquées, mais leur reçu n’a pas pu être enregistré. L’historique natif des modifications les contient toujours.',
  'costReview.op.cost.schedule.create': 'Créer un échéancier de coûts',
  'costReview.op.cost.item.create': 'Créer un poste de coût',
  'costReview.op.cost.value.create': 'Créer une valeur de coût fournie',
  'costReview.op.cost.quantity.create': 'Créer une quantité fournie',
  'costReview.op.cost.items.nest': 'Imbriquer des postes de coût',
  'costReview.op.cost.schedule.assign': 'Affecter des postes à l’échéancier',
  'costReview.op.cost.item.assign': 'Affecter des objets au poste de coût',
  'costReview.op.cost.item.values': 'Remplacer les valeurs de coût du poste',
  'costReview.op.cost.remove': 'Supprimer l’enregistrement de coût',
} satisfies Catalogue;
