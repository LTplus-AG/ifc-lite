/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const curtainGridFr = {
  "curtainWall.label": "Mur-rideau",
  "curtainWall.palette": "Placer des murs-rideaux",
  "commands.model.curtainWall": "Placer des murs-rideaux : montants, traverses et panneaux (espace Modèle)",
  "curtainWall.hint.start": "Cliquez pour commencer le mur-rideau · saisissez une longueur pour la verrouiller",
  "curtainWall.hint.end": "Cliquez ou appuyez sur Entrée pour le placer · la grille montre ses panneaux · Échap recommence",
  "curtainWall.field.baseOffset": "Base",
  "curtainWall.field.panelWidth": "L panneau",
  "curtainWall.field.panelHeight": "H panneau",
  "curtainWall.field.mullionWidth": "L montant",
  "curtainWall.field.mullionDepth": "P montant",
  "curtainWall.tooShort": "Le mur-rideau est trop court : cliquez plus loin du départ",
  "curtainWall.noOpening": "Les montants et traverses ne laissent aucune ouverture libre : élargissez les panneaux ou affinez le montant",
  "curtainWall.tooManyPanels": "Cette taille produit trop de panneaux : agrandissez-les",
  "curtainWall.summary": "{bays} × {rows} panneaux",
  "grid.label": "Trame",
  "grid.palette": "Placer des trames",
  "commands.model.grid": "Placer une trame de conception avec des axes repérés (espace Modèle)",
  "grid.hint.corner": "Cliquez sur le premier angle de la trame · saisissez une largeur pour la verrouiller",
  "grid.hint.opposite": "Cliquez sur l’angle opposé ou appuyez sur Entrée · Maj impose un carré · Échap recommence",
  "grid.field.spacingU": "Espacement U",
  "grid.field.spacingV": "Espacement V",
  "grid.tags.label": "Mode de repérage des axes",
  "grid.tags.numbers": "1, 2, 3",
  "grid.tags.letters": "A, B, C",
  "grid.noArea": "La trame n’a aucune surface : cliquez sur un angle éloigné du premier",
  "grid.tooManyAxes": "Cet espacement produit trop d’axes : augmentez-le",
  "grid.summary": "{uAxes} × {vAxes} axes",
} satisfies Catalogue;
