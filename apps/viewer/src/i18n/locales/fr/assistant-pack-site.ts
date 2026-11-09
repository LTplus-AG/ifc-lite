/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackSiteFr = {
  'assistantSources.zones.description': 'Zone dans laquelle se trouve chaque élément, avec son volume de maillage par zone et la raison lorsqu’un volume manque',
  'assistantSources.zones.rows': 'Chaque ligne correspond à un élément dans une zone qu’il atteint, avec sa part de volume',
  'assistantSources.zones.unavailable': 'Aucune affectation de zone n’est disponible. Créez d’abord un jeu de zones et laissez les éléments y être affectés.',
  'assistantSources.zones.suggestSummary': 'Résume la répartition des éléments entre les zones',
  'assistantSources.zones.suggestUnmeasured': 'Quels éléments n’ont pas de volume mesuré, et pourquoi ?',
  'assistantSources.zones.noSets': 'Aucun jeu de zones',
  'assistantSources.zones.notAssigned': 'Éléments pas encore affectés',
  'assistantSources.zones.ready': { one: '{count} jeu de zones', many: '{count} de jeux de zones', other: '{count} jeux de zones' },
  'assistantSources.placement.description': 'Déplacement et orientation de chaque modèle dans l’espace de travail, son géoréférencement et tout double géoréférencement',
  'assistantSources.placement.rows': 'Chaque ligne correspond à un modèle chargé avec son placement et son géoréférencement',
  'assistantSources.placement.unavailable': 'Aucun modèle n’est chargé ; il n’y a donc aucun placement à examiner.',
  'assistantSources.placement.suggestAlignment': 'Les modèles chargés sont-ils placés de manière cohérente les uns par rapport aux autres ?',
  'assistantSources.placement.suggestGeoref': 'Explique le géoréférencement de chaque modèle et tout ce qui semble incorrect',
  'assistantSources.layerDiff.title': 'Modifications de couche',
  'assistantSources.layerDiff.description': 'Ce qu’une couche IFCX ajoute, modifie et supprime dans la pile composée',
  'assistantSources.layerDiff.rows': 'Chaque ligne correspond à un chemin que la couche a ajouté, modifié ou supprimé',
  'assistantSources.layerDiff.unavailable': 'Aucune différence de couche n’a été calculée. Ouvrez d’abord les modifications d’une couche dans le panneau Couches.',
  'assistantSources.layerDiff.suggestSummary': 'Résume ce que cette couche modifie',
  'assistantSources.layerDiff.suggestReview': 'Que doit vérifier un relecteur avant d’accepter cette couche ?',
  'assistantSources.layerDiff.noStack': 'Aucune pile de couches chargée',
  'assistantSources.layerDiff.running': 'Calcul des modifications de couche',
  'assistantSources.layerDiff.notRun': 'Aucune modification de couche ouverte',
  'assistantSources.layerDiff.ready': { one: '{count} modification', many: '{count} de modifications', other: '{count} modifications' },
  'assistantSources.selection.title': 'Sélection',
  'assistantSources.selection.description': 'Les éléments sélectionnés avec leurs attributs, jeux de propriétés et quantités, modifications comprises',
  'assistantSources.selection.rows': 'Chaque ligne correspond à un élément sélectionné tel que l’affiche le panneau Propriétés',
  'assistantSources.selection.unavailable': 'Rien n’est sélectionné. Sélectionnez d’abord un ou plusieurs éléments.',
  'assistantSources.selection.suggestExplain': 'Explique ce qui est sélectionné et ce qu’il a de remarquable',
  'assistantSources.selection.suggestCompare': 'En quoi les éléments sélectionnés diffèrent-ils les uns des autres ?',
  'assistantSources.selection.none': 'Aucune sélection',
  'assistantSources.selection.ready': { one: '{count} élément sélectionné', many: '{count} d’éléments sélectionnés', other: '{count} éléments sélectionnés' },
} satisfies Catalogue;
