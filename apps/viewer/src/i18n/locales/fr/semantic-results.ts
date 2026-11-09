/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const semanticResultsFr = {
  "semantic.resultsSelectAll": "Sélectionner tous les résultats associés",
  "semantic.resultsClear": "Effacer la sélection",
  "semantic.resultsSelection": "Sélection",
  "semantic.resultsToggle": "Ajouter ou retirer la ligne de résultat {row}",
  "semantic.resultsSelectionHelp": "Les cases ajoutent ou retirent les entités associées. Tout sélectionner inclut toutes les pages et ignore les lignes non résolues ou ambiguës. Ctrl/Cmd-clic sur une association ajoute ou retire un candidat.",
  "semantic.resultsTitle": "Résultats SPARQL",
  "semantic.resultsPrevious": "Lignes précédentes",
  "semantic.resultsNext": "Lignes suivantes",
  "semantic.resultsPage": "Lignes {start}–{end} sur {count}",
  "semantic.resultsUnbound": "Non lié",
  "semantic.resultsSelect": "Sélectionner la ligne associée",
  "semantic.resultsCandidates": "Choisir un modèle candidat",
  "semantic.resultsChoose": "Sélectionner {model}, entité {id}",
  "semantic.resultsStatus": "Association IFC",
  "semantic.resultsResolved": "Résolu",
  "semantic.resultsAmbiguous": "Ambigu",
  "semantic.resultsUnmatched": "Sans correspondance",
  "semantic.resultsUnscoped": "Révision non associée",
  "semantic.resultsExternal": "Aucune identité IFC",
  "semantic.resultsInvalid": "Identité invalide",
  "semantic.resultsStale": "Le candidat n’est plus disponible ; résolvez à nouveau la ligne",
} satisfies Catalogue;
