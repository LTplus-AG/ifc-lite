/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const splitToolFr = {
  'splitTool.barLabel': 'Scinder',
  'splitTool.hint': 'Pointez l’élément sélectionné pour placer la coupe · saisissez une distance ou un % · Échap pour quitter',
  'splitTool.unitMetres': 'm',
  'splitTool.cutDistanceAria': 'Distance de coupe en mètres, ou pourcentage de la longueur de l’élément',
  'splitTool.unavailable.type': 'La scission fonctionne sur les murs, poutres, poteaux, barres, dalles, toitures, plaques et espaces',
  'splitTool.unavailable.storey': 'Scission impossible : l’élément n’est contenu dans aucun étage de bâtiment',
  'splitTool.unavailable.container': 'Scission impossible : l’élément se trouve directement dans le bâtiment ou le site, et non sur un étage. Déplacez-le d’abord sur un étage',
  'splitTool.unavailable.noBody': 'Scission impossible : l’élément n’a pas de géométrie de corps',
  'splitTool.unavailable.mesh': 'Scission impossible : la géométrie est un maillage ou une B-rep, et non une extrusion de profil',
  'splitTool.unavailable.mapped': 'Scission impossible : la géométrie est partagée avec son type (représentation mappée)',
  'splitTool.unavailable.boolean': 'Scission impossible : la géométrie est un solide découpé par une opération booléenne',
  'splitTool.unavailable.profile': 'Scission impossible : le profil d’extrusion n’est pas un rectangle',
  'splitTool.unavailable.shape': 'Scission impossible : le placement ou la structure de la représentation n’est pas pris en charge',
  'splitTool.unavailable.kind': 'Scission impossible : cette méthode de scission ne s’applique pas à cet élément',
  'splitTool.failed': 'Échec de la scission : {reason}',
} satisfies Catalogue;
