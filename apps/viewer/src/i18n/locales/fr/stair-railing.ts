/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const stairRailingFr = {
  'stairRailing.tool.stair': 'Escalier',
  'stairRailing.tool.railing': 'Garde-corps',
  'stairRailing.stair.label': 'Escalier',
  'stairRailing.railing.label': 'Garde-corps',
  'stairRailing.field.riser': 'Contremarche',
  'stairRailing.field.tread': 'Giron',
  'stairRailing.field.waist': 'Paillasse',
  'stairRailing.inspector.RiserHeight': 'Hauteur de marche',
  'stairRailing.inspector.TreadLength': 'Longueur du giron',
  'stairRailing.inspector.WaistThickness': 'Épaisseur de la paillasse',
  'stairRailing.inspector.effect': 'Le pied et le nombre de contremarches restent fixes. La hauteur de marche modifie la hauteur totale ; la longueur du giron modifie la longueur totale.',
  'stairRailing.field.postSpacing': 'Espacement des poteaux',
  'stairRailing.stair.hintStart': 'Cliquez au pied de la première contremarche · saisissez une longueur pour fixer la longueur de la volée',
  'stairRailing.stair.hintEnd': 'Cliquez ou appuyez sur Entrée pour placer l’escalier · saisissez une longueur, Tab pour l’angle, la contremarche, le giron · Retour arrière pour recommencer · Échap pour quitter',
  'stairRailing.stair.tooShort': 'La volée est trop courte : des girons de moins de 0,1 m ne forment pas un escalier. Dessinez-la plus longue, ou demandez une contremarche plus haute pour moins de marches',
  'stairRailing.stair.waistTooThick': 'La paillasse est trop épaisse pour une volée de cette hauteur : saisissez une valeur plus faible',
  'stairRailing.stair.risers': {
    one: '{countDisplay} contremarche · jusqu’à {storey}',
    many: '{countDisplay} de contremarches · jusqu’à {storey}',
    other: '{countDisplay} contremarches · jusqu’à {storey}',
  },
  'stairRailing.stair.risersFree': {
    one: '{countDisplay} contremarche · aucun étage au-dessus',
    many: '{countDisplay} de contremarches · aucun étage au-dessus',
    other: '{countDisplay} contremarches · aucun étage au-dessus',
  },
  'stairRailing.railing.hintStart': 'Cliquez pour commencer le garde-corps · s’accroche aux bords de dalle et aux côtés d’escalier · saisissez une longueur pour la fixer',
  'stairRailing.railing.hintNext': 'Cliquez pour ajouter un point · double-cliquez ou appuyez sur Entrée pour terminer · Retour arrière supprime un point · Échap pour recommencer',
  'stairRailing.railing.needTwo': 'Un garde-corps nécessite au moins deux points',
  'stairRailing.railing.summary': {
    one: '{countDisplay} point · {length}',
    many: '{countDisplay} de points · {length}',
    other: '{countDisplay} points · {length}',
  },
  'stairRailing.railing.finish': 'Terminer',
  'stairRailing.railing.finishTitle': 'Placer le garde-corps le long des points saisis (Entrée)',
  'commandPalette.tool.stair.label': 'Dessiner des escaliers',
  'commandPalette.tool.railing.label': 'Dessiner des garde-corps',
  'commands.model.stair': 'Dessiner un escalier jusqu’à l’étage supérieur (espace de travail Modèle)',
  'commands.model.railing': 'Dessiner un garde-corps le long d’un tracé (espace de travail Modèle)',
} satisfies Catalogue;
