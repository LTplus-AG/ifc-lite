/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const groupReviewFr = {
  'groupReview.title': 'Vérifier les modifications de groupes',
  'groupReview.hint': 'Sélectionnez des modifications, puis vérifiez les noms des groupes et leur composition complète. La suppression d’un groupe conserve ses membres et leurs autres appartenances.',
  'groupReview.prepare': 'Vérifier les modifications de groupes sélectionnées',
  'groupReview.acknowledgement': 'J’ai vérifié la composition complète et les références partagées.',
  'groupReview.population': 'Enregistrements natifs : {created} créés · {modified} modifiés · {deleted} supprimés',
  'groupReview.nativeChanges': 'Examiner les modifications de groupes et les références partagées',
  'groupReview.receiptProblem': 'Les modifications ont été appliquées, mais leur reçu n’a pas pu être enregistré. L’annulation reste disponible dans l’historique des modifications.',
  'groupReview.op.group.create': 'Créer un groupe',
  'groupReview.op.group.update': 'Mettre à jour le groupe et remplacer sa composition complète',
  'groupReview.op.group.remove': 'Supprimer le groupe',
} satisfies Catalogue;
