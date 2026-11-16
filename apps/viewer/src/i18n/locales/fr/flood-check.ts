/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const floodCheckFr = {
  "floodCheck.section.title": "Ruissellement",
  "floodCheck.section.intro": "Contrôle les portes, fenêtres, ouvertures et équipements proches du sol avec la carte fédérale de l’aléa ruissellement (OFEV) : lesquels se trouvent dans ou sous la classe de hauteur cartographiée à côté.",
  "floodCheck.section.screeningOnly": "Un contrôle sommaire avec une carte d’aléa publiée, pas une simulation d’inondation. La carte n’a pas de force juridique, et des zones indiquées comme non touchées peuvent l’être.",
  "floodCheck.section.showHazard": "Draper la carte de l’aléa ruissellement sur le terrain",
  "floodCheck.section.hazardNeedsTerrain": "Chargez le terrain du contexte ci-dessus pour y voir la carte.",
  "floodCheck.section.hazardFailed": "La carte de l’aléa ruissellement n’a pas pu être drapée : {reason}",
  "floodCheck.section.groundStorey": "Rez-de-chaussée",
  "floodCheck.section.groundStoreyGuess": "Non indiqué (le contrôle le devine)",
  "floodCheck.section.groundStoreyGuessNote": "Un rez-de-chaussée deviné peut être le sous-sol : aucun élément ne peut alors obtenir un résultat favorable. Indiquez-le pour le permettre.",
  "floodCheck.section.run": "Lancer le contrôle",
  "floodCheck.section.rerun": "Relancer",
  "floodCheck.section.cancel": "Annuler",
  "floodCheck.section.running": "Lecture du modèle, de la carte d’aléa et du terrain…",
  "floodCheck.section.refused": "Le contrôle a refusé : {reason}",
  "floodCheck.outcome.exposed": "Exposé",
  "floodCheck.outcome.openEnded": "Classe de hauteur sans borne supérieure",
  "floodCheck.outcome.withinRange": "Dans la plage de la classe",
  "floodCheck.outcome.aboveRange": "Au-dessus de la plage cartographiée",
  "floodCheck.outcome.noRunoffMapped": "Aucun ruissellement cartographié (pas « sûr »)",
  "floodCheck.outcome.unclassified": "Non établi",
  "floodCheck.summary.checked": "{count} éléments contrôlés",
  "floodCheck.summary.noRunoffNotSafe": "« Aucun ruissellement cartographié » signifie que la carte n’en montre pas à côté de l’élément. Cela ne signifie pas que l’élément est sûr.",
  "floodCheck.summary.showColours": "Colorer les éléments contrôlés selon le résultat",
  "floodCheck.summary.selectHint": "Sélectionnez un élément pour voir son résultat et son jeu de propriétés.",
  "floodCheck.summary.heightConfirmed": "Référence altimétrique contrôlée avec le terrain à côté des portes du rez-de-chaussée.",
  "floodCheck.summary.heightUnconfirmed": "Référence altimétrique non confirmée, aucun élément n’obtient donc de résultat favorable : {reasons}.",
  "floodCheck.summary.notes": "Remarques et réserves ({count})",
  "floodCheck.summary.disclaimer": "Avertissement et limites de l’éditeur",
  "floodCheck.summary.source": "Source : {source}. Données du {date}.",
  "floodCheck.summary.requests": "{requests} requêtes, {size}",
  "floodCheck.legend.hazardTitle": "Carte de l’aléa ruissellement (OFEV), hauteur d’écoulement",
  "floodCheck.legend.hazardCaveat": "Modélisée, événements rares à très rares. Sans force juridique ; des zones non marquées peuvent être touchées.",
  "floodCheck.legend.verdictTitle": "Contrôle sommaire inondation",
  "floodCheck.legend.verdictCaveat": "Exposition lue sur la carte d’aléa publiée. Pas une simulation d’inondation.",
  "floodCheck.card.heading": "Contrôle sommaire ruissellement",
  "floodCheck.card.notInModel": "Issu du contrôle lancé dans cette session ; non écrit dans le modèle.",
} satisfies Catalogue;
