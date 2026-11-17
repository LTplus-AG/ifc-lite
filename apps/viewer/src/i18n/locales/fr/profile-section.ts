/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const profileSectionFr = {
  'profileSection.kind.Rectangle': 'Rectangle',
  'profileSection.kind.I': 'I / H',
  'profileSection.kind.L': 'Cornière (L)',
  'profileSection.kind.T': 'Té (T)',
  'profileSection.kind.U': 'Profilé en U (U)',
  'profileSection.kind.C': 'Profilé en C à bords tombés (C)',
  'profileSection.kind.Circle': 'Cercle',
  'profileSection.kind.RectangleHollow': 'Rectangle creux',
  'profileSection.kind.CircleHollow': 'Cercle creux',
  'profileSection.field.width': 'Largeur',
  'profileSection.field.height': 'Hauteur',
  'profileSection.field.depth': 'Profondeur',
  'profileSection.field.overallWidth': 'Largeur',
  'profileSection.field.overallDepth': 'Profondeur',
  'profileSection.field.flangeWidth': 'Largeur de l’aile',
  'profileSection.field.web': 'Âme',
  'profileSection.field.flange': 'Aile',
  'profileSection.field.thickness': 'Épaisseur',
  'profileSection.field.wall': 'Paroi',
  'profileSection.field.girth': 'Bord tombé',
  'profileSection.field.radius': 'Rayon',
  'profileSection.fieldAria': '{label} en mètres',
  'profileSection.picker.label': 'Section',
  'profileSection.picker.title': 'Choisir la section transversale des nouveaux éléments',
  'profileSection.picker.button': 'Section : {kind}',
  'profileSection.kindAria': 'Type de section',
  'profileSection.previewAria': 'Aperçu de la section : {kind}, {across} × {up}',
  'profileSection.invalid': 'Ce profil ({kind}) ne convient pas : {reason}',
  'profileSection.inspector.title': 'Profil',
  'profileSection.inspector.unavailable': 'Le profil peut être modifié sur un élément construit directement à partir d’une section',
  'profileSection.inspector.dimsNote': 'Un rectangle se dimensionne dans Dimensions',
  'profileSection.inspector.outerSize': 'La taille extérieure suit la section : modifiez-la dans Profil',
  'profileSection.inspector.edit': 'Modifier le profil',
} satisfies Catalogue;
