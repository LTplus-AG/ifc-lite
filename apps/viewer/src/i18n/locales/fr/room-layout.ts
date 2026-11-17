/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const roomLayoutFr = {
  'roomLayout.mode.edit': 'Modifier',
  'roomLayout.tool.label': 'Effet d’un clic sur la disposition',
  'roomLayout.tool.shape': 'Déplacer · Couper',
  'roomLayout.tool.remove': 'Fusionner · Supprimer',
  'roomLayout.tool.shapeTitle': 'Faites glisser un angle pour le déplacer ; cliquez sur deux points du contour d’une pièce pour la couper entre eux',
  'roomLayout.tool.removeTitle': 'Cliquez sur le mur séparant deux pièces pour les fusionner ; cliquez sur un angle pour le supprimer',
  'roomLayout.cleanup.label': 'Nettoyer',
  'roomLayout.cleanup.title': 'Supprimer de la disposition les murs pendants, les nœuds isolés et les angles superflus, en une seule étape d’annulation',
  'roomLayout.hint.shape': 'Faites glisser un angle pour le déplacer · cliquez sur le contour d’une pièce pour commencer une coupe',
  'roomLayout.hint.remove': 'Cliquez sur le mur séparant deux pièces pour les fusionner, ou sur un angle pour le supprimer',
  'roomLayout.hint.drop': 'Relâchez ou cliquez pour déposer l’angle · Échap pour annuler',
  'roomLayout.hint.cutEnd': 'Cliquez sur un autre point du même contour de pièce pour la couper · Échap pour annuler',
  'roomLayout.hint.open': 'Aucun mur ne ferme cette zone : les extrémités de mur ouvertes sont signalées',
  'roomLayout.edit.none': 'Pointez d’abord un angle ou le contour d’une pièce',
  'roomLayout.edit.refused': 'La disposition ne peut pas accepter cette modification : {reason}',
  'roomLayout.prune.none': 'Rien à nettoyer : la disposition ne comporte aucun mur ni nœud isolé',
  'roomLayout.refused.shape': 'Une pièce ici n’est pas un contour extrudé verticalement ; sa forme ne peut donc pas être modifiée : utilisez Mettre à jour les pièces ou redessinez-la',
  'roomLayout.refused.storey': 'Une pièce ici n’est rattachée à aucun étage ; sa forme ne peut donc pas être modifiée',
  'roomLayout.refused.merge': 'L’une des pièces fusionnées n’a pas pu être supprimée',
  'roomLayout.more.label': 'Plus',
  'roomLayout.more.title': 'Emprise, Auto sur chaque étage, soudure des angles et diagnostic des fuites',
  'roomLayout.footprint.label': 'Emprise',
  'roomLayout.footprint.title': 'Une seule pièce sur tout le contour de cet étage, en une seule étape d’annulation',
  'roomLayout.footprint.taken': 'Cet étage comporte déjà des pièces : Emprise crée une seule pièce sur tout l’étage, qui les chevaucherait',
  'roomLayout.autoAll.label': 'Auto sur chaque étage',
  'roomLayout.autoAll.title': 'Transformer en pièce chaque zone fermée par des murs qui n’en a pas encore, sur chaque étage, en une seule étape d’annulation',
  'roomLayout.autoAll.none': 'Chaque zone fermée par des murs sur chaque étage a déjà une pièce',
  'roomLayout.weld.label': 'Soudure des angles',
  'roomLayout.weld.title': 'Distance en dessous de laquelle deux angles de mur comptent comme un seul : augmentez-la lorsque des murs qui se rejoignent laissent une pièce ouverte',
  'roomLayout.weld.aria': 'Soudure des angles (mètres)',
  'roomLayout.weld.auto': 'Par défaut (5 cm)',
  'roomLayout.weld.reset': 'Rétablir la valeur par défaut de 5 cm',
  'roomLayout.weld.rooms': {
    one: '{countDisplay} pièce',
    many: '{countDisplay} de pièces',
    other: '{countDisplay} pièces',
  },
  'roomLayout.leaks.label': 'Afficher les fuites',
  'roomLayout.leaks.title': 'Signaler les murs qui ne ferment aucune pièce et les extrémités de mur qui ne touchent rien : pourquoi une zone n’est pas fermée',
} satisfies Catalogue;
