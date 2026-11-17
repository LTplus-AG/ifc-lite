/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const zoneEmissionFr = {
  "zoneEmission.title": "Réviser la création des zones évaluées",
  "zoneEmission.hint": "Créer ce jeu complet de zones évaluées uniquement dans le modèle choisi. Les membres proviennent de l’évaluation native actuelle.",
  "zoneEmission.limit": "Les résultats antérieurs de cette session sont remplacés. Les zones importées d’un précédent fichier IFC sont conservées. Les autres modèles restent inchangés. Aucun aperçu des solides produits n’est disponible.",
  "zoneEmission.prepare": "Préparer la création native des zones",
  "zoneEmission.apply": "Créer les zones révisées",
  "zoneEmission.population": "{zones} zones, {members} éléments évalués, {replaced} zones antérieures remplacées ; {imported} zones importées conservées.",
  "zoneEmission.records": "Enregistrements de sortie natifs",
  "zoneEmission.frame": "Unités et repère natifs du modèle",
  "zoneEmission.receiptProblem": "Le modèle a changé, mais le reçu n’a pas pu être enregistré. L’annulation reste disponible dans le panneau natif Modifications.",
} satisfies Catalogue;
