/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantSourcesFr = {
  "assistantSources.groupChecks": "Contrôles",
  "assistantSources.groupCoordination": "Coordination",
  "assistantSources.groupQuantities": "Quantités",
  "assistantSources.groupModel": "Modèle",
  "assistantSources.groupAutomation": "Automatisation",
  "assistantSources.unsupportedTitle": "Discussion indisponible",
  "assistantSources.unsupportedHint": "Ces panneaux n’ont aucun résultat d’analyse propre à joindre.",
  "assistantSources.boundaryAppearance": "Paramètres d’apparence de l’affichage, sans résultat d’analyse.",
  "assistantSources.boundaryModel": "Outils de création. Discutez des modifications via Modifications ou Jeux de modifications.",
  "assistantSources.boundaryExtensions": "Extensions installées et autorisations associées. Discutez du résultat d’une extension dans le panneau qui l’affiche.",
  "assistantSources.boundaryCollab": "Participants et autorisations de la session en direct ; aucun résultat d’analyse.",
  "assistantSources.boundarySources": "Connexions au cloud et récupération des données. Les identifiants et les autorisations d’accès aux points de terminaison ne font jamais partie du contexte fourni.",
  "assistantSources.boundaryPresentation": "Vues de caméra enregistrées pour les présentations ; aucun résultat d’analyse.",
  "assistantSources.boundaryAssistant": "L’Assistant lui-même. Les conversations enregistrées sont rouvertes, jamais jointes comme contexte.",
  "assistantSources.boundaryEnvironment": "Paramètres d’affichage du ciel, de l’éclairage et de l’heure solaire. Aucune analyse solaire n’est enregistrée ; ces paramètres ne mesurent pas les performances en lumière naturelle.",
  "assistantSources.boundaryIdsStudio": "Création IDS. Modifier un document d’exigences ne produit aucun résultat d’analyse ; exécutez-le dans Validation pour discuter de ses constats.",
  "assistantSources.boundaryInflux": "Télémétrie InfluxDB expérimentale. Les mesures sont récupérées avec un jeton limité à la session et ne sont pas partagées avec l’assistant.",
} satisfies Catalogue;
