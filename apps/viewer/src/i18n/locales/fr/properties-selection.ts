/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const propertiesSelectionFr = {
  "properties.copy.valueLabel": "Copier {name}",
  "properties.copy.valueTooltip": "Copier {name} (Maj ou appui prolongé : copier nom=valeur)",
  "properties.copy.copied": "Copié dans le presse-papiers",
  "properties.copy.failed": "Impossible de copier dans le presse-papiers",
  "properties.summary.elementCount": {"one":"{countDisplay} élément","other":"{countDisplay} éléments","many":"{countDisplay} éléments"},
  "properties.summary.byClassHeading": "Par classe",
  "properties.summary.byModelHeading": "Par modèle",
  "properties.summary.elementsHeading": "Éléments",
  "properties.summary.attributesHeading": "Attributs communs",
  "properties.summary.propertiesHeading": "Propriétés communes",
  "properties.summary.quantitiesHeading": "Quantités communes",
  "properties.summary.varies": {"one":"(variable : {countDisplay} valeur)","other":"(variable : {countDisplay} valeurs)","many":"(variable : {countDisplay} valeurs)"},
  "properties.summary.noShared": "Les éléments sélectionnés n’ont aucune propriété ni quantité commune",
  "properties.summary.selectOnly": "Sélectionner uniquement {name}",
  "properties.summary.moreElements": {"one":"{countDisplay} élément supplémentaire","other":"{countDisplay} éléments supplémentaires","many":"{countDisplay} éléments supplémentaires"},
  "properties.summary.valuesCapped": "Valeurs comparées sur les {limit} premiers éléments sur {total}",
} satisfies Catalogue;
