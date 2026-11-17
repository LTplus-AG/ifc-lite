/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const copyArrayFr = {
  "commands.model.copy": "Copier les éléments sélectionnés (espace Modèle)",
  "commands.model.paste": "Coller les éléments copiés au curseur (espace Modèle)",
  "commands.model.pasteInPlace": "Coller les éléments copiés sur place, à l’étage actuel (espace Modèle)",
  "commands.model.array": "Répéter les éléments sélectionnés en ligne ou autour d’un centre (espace Modèle)",
  "copyArray.copied": {"one":"{countDisplay} élément copié","other":"{countDisplay} éléments copiés","many":"{countDisplay} éléments copiés"},
  "copyArray.cameFree": {
    "one": "{countDisplay} copie n’a pas été placée à une intersection de la grille et n’est donc plus liée à la grille",
    "other": "{countDisplay} copies n’ont pas été placées à une intersection de la grille et ne sont donc plus liées à la grille",
    "many": "{countDisplay} copies n’ont pas été placées à une intersection de la grille et ne sont donc plus liées à la grille",
  },
  "copyArray.unattachedTops": {
    "one": "{countDisplay} copie garde sa hauteur : son sommet ne peut pas suivre son nouveau niveau, elle n’y est donc plus liée",
    "other": "{countDisplay} copies gardent leur hauteur : leur sommet ne peut pas suivre leur nouveau niveau, elles n’y sont donc plus liées",
    "many": "{countDisplay} copies gardent leur hauteur : leur sommet ne peut pas suivre leur nouveau niveau, elles n’y sont donc plus liées",
  },
  "copyArray.paste.label": "Coller",
  "copyArray.paste.hint": "Cliquez à l’emplacement de la copie. Pour coller à un autre étage, changez d’abord d’étage",
  "copyArray.paste.empty": "Rien n’est encore copié : sélectionnez d’abord des éléments et copiez-les",
  "copyArray.paste.stale": "Les éléments copiés ne peuvent plus être copiés : sélectionnez-les et copiez-les à nouveau",
  "copyArray.paste.otherModel": "Les éléments copiés appartiennent à un autre modèle : collez-les dans celui-ci",
  "copyArray.tool.array": "Réseau",
  "copyArray.blocked.array": "Sélectionnez d’abord les éléments à répéter",
  "copyArray.array.label": "Réseau",
  "copyArray.array.noSelection": "Sélectionnez d’abord les éléments à répéter",
  "copyArray.array.refused": "Ces éléments ne peuvent pas être répétés : cliquez pour savoir pourquoi",
  "copyArray.array.linearStart": "Cliquez au point de départ de la direction",
  "copyArray.array.linearEnd": "Cliquez au point d’arrivée : cette distance représente un pas (Espacement) ou l’ensemble du réseau (Ajuster)",
  "copyArray.array.polarCentre": "Cliquez sur le centre autour duquel tourner les copies",
  "copyArray.array.polarCommit": "Cliquez ou appuyez sur Entrée pour placer les copies",
  "copyArray.field.count": "Nombre",
  "copyArray.field.spacing": "Espacement",
  "copyArray.field.total": "Total",
  "copyArray.field.angle": "Angle",
  "copyArray.mode.label": "Type de réseau",
  "copyArray.mode.linear": "Linéaire",
  "copyArray.mode.polar": "Polaire",
  "copyArray.fit.label": "Ce que mesure la distance",
  "copyArray.fit.spacing": "Espacement",
  "copyArray.fit.fit": "Ajuster",
  "copyArray.fit.spacingTitle": "La distance représente le pas d’une copie à la suivante",
  "copyArray.fit.fitTitle": "La distance couvre l’ensemble du réseau",
} satisfies Catalogue;
