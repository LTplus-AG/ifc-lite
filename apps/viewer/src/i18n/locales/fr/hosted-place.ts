/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const hostedPlaceFr = {
  'hostedPlace.tool.opening': 'Ouverture',
  'hostedPlace.tool.door': 'Porte',
  'hostedPlace.tool.window': 'Fenêtre',
  'hostedPlace.hint.opening': 'Pointez un mur et cliquez pour découper une ouverture · Échap pour quitter',
  'hostedPlace.hint.door': 'Pointez un mur et cliquez pour placer la porte · Échap pour quitter',
  'hostedPlace.hint.window': 'Pointez un mur et cliquez pour placer la fenêtre · Échap pour quitter',
  'hostedPlace.field.offset': 'Décalage',
  'hostedPlace.field.sill': 'Allège',
  'hostedPlace.noHost': 'Les portes, fenêtres et ouvertures se placent dans un mur : pointez-en un sur cet étage',
  'hostedPlace.outsideHost': 'L’élément ne tient pas dans ce mur : modifiez son décalage, son allège ou sa taille',
  'commandPalette.tool.opening.label': 'Découper des ouvertures',
  'commandPalette.tool.door.label': 'Placer des portes',
  'commandPalette.tool.window.label': 'Placer des fenêtres',
  'commands.model.opening': 'Découper des ouvertures dans les murs (espace de travail Modèle)',
  'commands.model.door': 'Placer des portes dans les murs (espace de travail Modèle)',
  'commands.model.window': 'Placer des fenêtres dans les murs (espace de travail Modèle)',
  'modelInspector.hosting.host': 'Hôte',
  'modelInspector.hosting.selectHost': 'Sélectionner l’hôte',
  'modelInspector.hosting.offset': 'Décalage',
  'modelInspector.hosting.sill': 'Allège',
  'modelInspector.hosting.none': 'Non hébergé : cet élément ne remplit aucune ouverture dans un mur.',
  'modelInspector.hosting.invalid': 'Saisissez une longueur en mètres',
  'modelInspector.type.noClass': '{schema} ne comporte pas de {typeClass} ; cet élément ne conserve donc aucun type.',
} satisfies Catalogue;
