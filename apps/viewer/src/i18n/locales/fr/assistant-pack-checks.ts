/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackChecksFr = {
  "assistantSources.duplicates.title": "Éléments en double",
  "assistantSources.duplicates.description": "Groupes de copies coïncidentes ou superposées détectés par la recherche de doublons.",
  "assistantSources.duplicates.rows": "Chaque ligne représente un groupe d’éléments coïncidents, et non une paire.",
  "assistantSources.duplicates.unavailable": "Aucun résultat de recherche de doublons n’était disponible lors de la capture. Lancez Rechercher les doublons dans Détection des collisions et actualisez les éléments de contexte.",
  "assistantSources.duplicates.suggestSummary": "Résumer les groupes de doublons et les types d’éléments concernés",
  "assistantSources.duplicates.suggestCleanup": "Quels groupes semblent être des copies exactes à supprimer en priorité ?",
  "assistantSources.duplicates.pickSets": {"one":"{count} groupe de doublons","other":"{count} groupes de doublons","many":"{count} groupes de doublons"},
  "assistantSources.manualChecklist.title": "Liste de contrôle manuelle",
  "assistantSources.manualChecklist.description": "Liste de contrôle manuelle ouverte et verdicts enregistrés par les réviseurs pour chaque modèle chargé.",
  "assistantSources.manualChecklist.rows": "Chaque ligne représente un point de contrôle sur un modèle, avec le verdict du réviseur ou sans verdict pour le moment.",
  "assistantSources.manualChecklist.unavailable": "Aucune liste de contrôle manuelle n’était ouverte lors de la capture. Ouvrez-en ou créez-en une dans Validation des données et actualisez les éléments de contexte.",
  "assistantSources.manualChecklist.suggestSummary": "Résumer l’avancement de la liste de contrôle et les points en échec",
  "assistantSources.manualChecklist.suggestOpen": "Quels points restent sans réponse et que faut-il vérifier ensuite ?",
  "assistantSources.manualChecklist.pickItems": {"one":"{count} point","other":"{count} points","many":"{count} points"},
  "assistantSources.manualChecklist.pickNone": "Aucune liste de contrôle ouverte",
  "assistantSources.lens.description": "Nombre d’éléments correspondant à chaque règle de la Lens active, avec des exemples.",
  "assistantSources.lens.rows": "Chaque ligne représente une règle Lens ou une valeur de coloration, avec le nombre de correspondances fourni par la source.",
  "assistantSources.lens.unavailable": "Aucune Lens évaluée n’était active lors de la capture. Activez une Lens et actualisez les éléments de contexte.",
  "assistantSources.lens.suggestSummary": "Expliquer ce que montre la Lens active et quelles règles correspondent au plus grand nombre d’éléments",
  "assistantSources.lens.pickRules": {"one":"{name} · {count} règle","other":"{name} · {count} règles","many":"{name} · {count} règles"},
  "assistantSources.lens.pickNone": "Aucune Lens active",
  "assistantSources.lens.pickPending": "Évaluation en cours…",
  "assistantSources.bcf.description": "Sujets du projet BCF chargé : statut, priorité, attribution et éléments référencés.",
  "assistantSources.bcf.rows": "Chaque ligne représente un sujet BCF. Le texte des commentaires et les captures ne sont pas inclus.",
  "assistantSources.bcf.unavailable": "Aucun projet BCF n’était chargé lors de la capture. Ouvrez ou créez des sujets BCF et actualisez les éléments de contexte.",
  "assistantSources.bcf.suggestSummary": "Résumer les sujets ouverts par statut et priorité",
  "assistantSources.bcf.suggestPriorities": "Quels sujets faut-il résoudre en priorité et à qui sont-ils attribués ?",
  "assistantSources.bcf.pickTopics": {"one":"{count} sujet","other":"{count} sujets","many":"{count} sujets"},
  "assistantSources.bcf.pickNone": "Aucun projet BCF",
} satisfies Catalogue;
