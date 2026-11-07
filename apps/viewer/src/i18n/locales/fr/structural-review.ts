/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralReviewFr = {
  "structuralReview.title": "Réviser le graphe analytique fourni",
  "structuralReview.hint": "Examinez uniquement la géométrie, les conditions d’appui et les composantes de charges fournies. Cette action crée des enregistrements IFC ; elle ne calcule ni ne valide une conception d’ingénierie. Sélectionnez les opérations, puis examinez toutes les modifications natives avant d’appliquer.",
  "structuralReview.prepare": "Réviser les opérations structurelles sélectionnées",
  "structuralReview.references": "Cible native : {target} · enregistrements liés : {related}",
  "structuralReview.acknowledgement": "Je confirme que les valeurs de charge et de rigidité sont fournies dans les unités natives du modèle. Aucune conversion ni déclaration d’unité manquante n’est supposée.",
  "structuralReview.previewUnavailable": "Aucun aperçu de la géométrie analytique n’est disponible ici. Examinez les enregistrements IFC natifs avant d’appliquer.",
  "structuralReview.population": "{records} enregistrements source révisés · {created} créés · {modified} modifiés · {deleted} supprimés. Les identités IFC créées sont attribuées à l’application.",
  "structuralReview.units": "Examiner les unités natives déclarées et les déclarations indisponibles",
  "structuralReview.nativeChanges": "Examiner les modifications IFC natives, y compris les références partagées et les suppressions",
  "structuralReview.receiptProblem": "Les modifications ont été appliquées, mais leur reçu n’a pas pu être enregistré. L’historique natif contient toujours les modifications.",
  "structuralReview.op.structural.analysis.create": "Créer un modèle analytique",
  "structuralReview.op.structural.member.create": "Créer un élément analytique courbe",
  "structuralReview.op.structural.connection.create": "Créer une connexion analytique ponctuelle",
  "structuralReview.op.structural.group.create": "Créer le groupe de charges fourni",
  "structuralReview.op.structural.pointAction.create": "Créer l’action ponctuelle fournie",
  "structuralReview.op.structural.linearAction.create": "Créer l’action linéaire fournie",
  "structuralReview.op.structural.member.connect": "Relier l’élément et la connexion",
  "structuralReview.op.structural.activity.connect": "Relier l’activité fournie à l’élément",
  "structuralReview.op.structural.group.assign": "Affecter les objets fournis au groupe",
} satisfies Catalogue;
