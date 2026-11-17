/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackCoordinationFr = {
  "assistantSources.changes.description": "Modifications de l’historique d’annulation de cette session, par opération et par modèle.",
  "assistantSources.changes.rows": "Les lignes représentent les modifications individuelles des opérations actives, de la plus récente à la plus ancienne.",
  "assistantSources.changes.unavailable": "Aucun modèle n’est chargé ; il n’y a donc aucun historique de modifications à joindre.",
  "assistantSources.changes.ready": {"one":"{count} modification","other":"{count} modifications","many":"{count} modifications"},
  "assistantSources.changes.none": "Aucune modification pour le moment",
  "assistantSources.changes.suggestSummary": "Résumer ce qui a été modifié et dans quels modèles",
  "assistantSources.changes.suggestReview": "Quelles modifications faut-il vérifier avant l’export ?",
  "assistantSources.changeSets.description": "Groupes nommés de modifications : taille, modèles et types de modification.",
  "assistantSources.changeSets.rows": "Les lignes représentent des jeux de modifications (métadonnées uniquement, sans les valeurs modifiées ni le contenu des fichiers).",
  "assistantSources.changeSets.unavailable": "Aucun jeu de modifications n’existe. Créez-en un dans le panneau Jeux de modifications.",
  "assistantSources.changeSets.ready": {"one":"{count} jeu de modifications","other":"{count} jeux de modifications","many":"{count} jeux de modifications"},
  "assistantSources.changeSets.none": "Aucun jeu de modifications",
  "assistantSources.changeSets.suggestSummary": "Résumer le contenu de chaque jeu de modifications",
  "assistantSources.schedule.description": "Tâches du planning 4D, avec dates, jalons et éléments affectés.",
  "assistantSources.schedule.rows": "Les lignes représentent les tâches du planning. Les dates manquantes sont nulles, jamais estimées.",
  "assistantSources.schedule.unavailable": "Aucun planning n’est chargé. Ouvrez le panneau Planning pour lire les données IfcTask, ou générez ou importez un planning.",
  "assistantSources.schedule.ready": {"one":"{count} tâche","other":"{count} tâches","many":"{count} tâches"},
  "assistantSources.schedule.none": "Aucun planning",
  "assistantSources.schedule.suggestSummary": "Résumer le planning : phases, jalons et durée totale",
  "assistantSources.schedule.suggestGaps": "Quelles tâches n’ont pas de dates ou d’éléments affectés ?",
  "assistantSources.semantic.description": "Enregistrements liés, leur correspondance avec les éléments du modèle, constats de validation et textes de spécifications joints.",
  "assistantSources.semantic.rows": "Les lignes représentent les passages de texte joints avec leurs positions exactes, puis les enregistrements liés et leur résolution, puis les constats de validation.",
  "assistantSources.semantic.unavailable": "Aucun enregistrement lié n’est chargé et aucun texte n’est joint. Chargez des enregistrements ou joignez un texte dans le panneau Enregistrements liés.",
  "assistantSources.semantic.ready": {"one":"{count} enregistrement · {findings} constats","other":"{count} enregistrements · {findings} constats","many":"{count} enregistrements · {findings} constats"},
  "assistantSources.semantic.none": "Aucun enregistrement chargé",
  "assistantSources.semantic.suggestUnresolved": "Quels enregistrements ne correspondent à aucun élément du modèle et pourquoi ?",
  "assistantSources.semantic.suggestFindings": "Expliquer les constats de validation",
  "assistantSources.review.description": "Une fiche de coordination de l’espace Révision : constats de plusieurs analyses portant sur les mêmes éléments validés.",
  "assistantSources.review.rows": "Les lignes représentent les constats de la fiche, chacun avec son analyse source, son statut d’origine et le caractère actuel, historique ou partiel de son exécution.",
  "assistantSources.review.unavailable": "Aucune fiche n’est épinglée. Choisissez Interroger sur cette fiche sur une fiche de l’espace Révision.",
  "assistantSources.review.ready": {"one":"{count} constat dans la fiche épinglée","other":"{count} constats dans la fiche épinglée","many":"{count} constats dans la fiche épinglée"},
  "assistantSources.review.none": "Aucune fiche épinglée",
  "assistantSources.review.suggestExplain": "Pourquoi ces constats concernent-ils les mêmes éléments ?",
  "assistantSources.review.suggestNext": "Que vérifierait ensuite un coordinateur sur cette fiche ?",
} satisfies Catalogue;
