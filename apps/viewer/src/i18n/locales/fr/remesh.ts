/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const remeshFr = {
  'remesh.refused.noSource': 'Les formes 3D de ce modèle ne peuvent pas être reconstruites après modification : il n’a pas été chargé depuis un fichier IFC.',
  'remesh.refused.noFrame': 'Les formes 3D de ce modèle ne peuvent pas être reconstruites après modification : il a été chargé sans le repère de coordonnées du moteur. Rechargez-le pour activer les mises à jour.',
  'remesh.refused.colourMerged': 'L’élément modifié partage un même maillage avec d’autres éléments ; sa forme 3D ne peut donc pas être reconstruite séparément. La modification est conservée.',
  'remesh.refused.unreadable': 'Les données de l’élément modifié n’ont pas pu être relues ; sa forme 3D n’a donc pas été reconstruite. La modification est conservée.',
  'remesh.refused.alignment': 'Le modèle de l’élément modifié est aligné sur le système de coordonnées d’un autre modèle, et la forme reconstruite n’a pas pu être alignée de la même manière. La modification est conservée.',
  'remesh.failed': 'La forme 3D de l’élément modifié n’a pas pu être reconstruite : {message}. La modification est conservée.',
} satisfies Catalogue;
