/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const flowReviewFr = {
  "flowReview.title": "Examiner la proposition de l'IA",
  "flowReview.paused": { one: "L'exécution s'est arrêtée à {nodes}. Rien en aval de ce nœud ne s'exécute tant que vous n'approuvez pas cette proposition.", other: "L'exécution s'est arrêtée à {nodes}. Rien en aval de ces nœuds ne s'exécute tant que vous n'approuvez pas cette proposition." },
  "flowReview.node": "{node} ({type})",
  "flowReview.digest": "Proposition {digest}",
  "flowReview.created": "Enregistrée pour examen {time}",
  "flowReview.coverage.classify": "{rows} lignes · {classified} classées · {unknown} inconnues · {failed} en échec · {notSent} non envoyées · {requests} requêtes · modèle {model}",
  "flowReview.coverage.summarize": "{rows} lignes · {sent} envoyées · {sections} sections · {uncited} non citées · {requests} requêtes · modèle {model}",
  "flowReview.coverage.extract": "{passages} passages · {sent} envoyés · {records} enregistrements · {unsupported} non étayés · {requests} requêtes · modèle {model}",
  "flowReview.approve": "Approuver et reprendre",
  "flowReview.resume": "Reprendre",
  "flowReview.reject": "Rejeter",
  "flowReview.dismiss": "Ignorer",
  "flowReview.state.prepared": "Rien en aval ne s'est exécuté. Approuvez pour poursuivre l'exécution avec exactement cette proposition, ou rejetez-la.",
  "flowReview.state.reviewed": "Approuvée. Reprendre exécute le reste du graphe à partir d'exactement cette proposition.",
  "flowReview.state.applying": "Reprise à partir de la proposition approuvée…",
  "flowReview.state.completed": "Reprise effectuée à partir de la proposition approuvée. Les nœuds terminés avant la pause ont été restaurés, et non réexécutés, et aucune nouvelle requête d'IA n'a été envoyée pour cette proposition.",
  "flowReview.state.partial": "La reprise n'est pas allée jusqu'au bout ({reason}). Les effets en aval peuvent être partiels ; cette proposition ne peut plus être reprise. Exécutez à nouveau le graphe pour un nouvel examen.",
  "flowReview.state.rejected": "Rejetée. Rien en aval de la proposition ne s'est exécuté.",
  "flowReview.refused.graph-changed": "Le graphe ou ses entrées du lecteur ont changé après la création de cette proposition. Exécutez à nouveau le graphe pour un nouvel examen.",
  "flowReview.refused.sources-changed": "Les modèles ou leurs modifications ont changé après la création de cette proposition. Exécutez à nouveau le graphe pour un nouvel examen.",
  "flowReview.refused.other": "Cette proposition ne peut pas être reprise : {reason}",
  "flowReview.notSaved": "La proposition n'a pas pu être enregistrée pour examen ; rien en aval ne s'est donc exécuté : {reason}",
  "flowReview.needsModel": "Les nœuds d'IA utilisent le modèle choisi pour l'Assistant. Choisissez un modèle, ou ajoutez-en une clé, pour exécuter ce graphe.",
} satisfies Catalogue;
