/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const profileSectionDe = {
  'profileSection.kind.Rectangle': 'Rechteck',
  'profileSection.kind.I': 'I / H',
  'profileSection.kind.L': 'Winkel (L)',
  'profileSection.kind.T': 'T-Profil (T)',
  'profileSection.kind.U': 'U-Profil (U)',
  'profileSection.kind.C': 'C-Profil mit Lippe (C)',
  'profileSection.kind.Circle': 'Kreis',
  'profileSection.kind.RectangleHollow': 'Rechteckhohlprofil',
  'profileSection.kind.CircleHollow': 'Rundhohlprofil',
  'profileSection.field.width': 'Breite',
  'profileSection.field.height': 'Höhe',
  'profileSection.field.depth': 'Tiefe',
  'profileSection.field.overallWidth': 'Breite',
  'profileSection.field.overallDepth': 'Tiefe',
  'profileSection.field.flangeWidth': 'Flanschbreite',
  'profileSection.field.web': 'Steg',
  'profileSection.field.flange': 'Flansch',
  'profileSection.field.thickness': 'Dicke',
  'profileSection.field.wall': 'Wand',
  'profileSection.field.girth': 'Lippe',
  'profileSection.field.radius': 'Radius',
  'profileSection.fieldAria': '{label} in Metern',
  'profileSection.picker.label': 'Querschnitt',
  'profileSection.picker.title': 'Querschnitt neuer Bauteile wählen',
  'profileSection.picker.button': 'Querschnitt: {kind}',
  'profileSection.kindAria': 'Querschnittsart',
  'profileSection.previewAria': 'Querschnittsvorschau: {kind}, {across} × {up}',
  'profileSection.invalid': 'Dieser Querschnitt ({kind}) passt nicht: {reason}',
  'profileSection.inspector.title': 'Profil',
  'profileSection.inspector.unavailable': 'Das Profil kann bei einem Bauteil geändert werden, das direkt aus einem Querschnitt erzeugt wurde',
  'profileSection.inspector.dimsNote': 'Die Größe eines Rechtecks wird unter Abmessungen festgelegt',
  'profileSection.inspector.outerSize': 'Die Außengröße folgt dem Querschnitt: Ändern Sie sie unter Profil',
  'profileSection.inspector.edit': 'Profil ändern',
} satisfies Catalogue;
