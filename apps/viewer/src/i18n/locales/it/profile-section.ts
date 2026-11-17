/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const profileSectionIt = {
  'profileSection.kind.Rectangle': 'Rettangolo',
  'profileSection.kind.I': 'I / H',
  'profileSection.kind.L': 'Angolare (L)',
  'profileSection.kind.T': 'Profilo a T (T)',
  'profileSection.kind.U': 'Profilo a U (U)',
  'profileSection.kind.C': 'Profilo a C con risvolto (C)',
  'profileSection.kind.Circle': 'Cerchio',
  'profileSection.kind.RectangleHollow': 'Rettangolo cavo',
  'profileSection.kind.CircleHollow': 'Cerchio cavo',
  'profileSection.field.width': 'Larghezza',
  'profileSection.field.height': 'Altezza',
  'profileSection.field.depth': 'Profondità',
  'profileSection.field.overallWidth': 'Larghezza',
  'profileSection.field.overallDepth': 'Profondità',
  'profileSection.field.flangeWidth': 'Larghezza dell’ala',
  'profileSection.field.web': 'Anima',
  'profileSection.field.flange': 'Ala',
  'profileSection.field.thickness': 'Spessore',
  'profileSection.field.wall': 'Parete',
  'profileSection.field.girth': 'Risvolto',
  'profileSection.field.radius': 'Raggio',
  'profileSection.fieldAria': '{label} in metri',
  'profileSection.picker.label': 'Sezione',
  'profileSection.picker.title': 'Scegli la sezione trasversale dei nuovi elementi',
  'profileSection.picker.button': 'Sezione: {kind}',
  'profileSection.kindAria': 'Tipo di sezione',
  'profileSection.previewAria': 'Anteprima della sezione: {kind}, {across} per {up}',
  'profileSection.invalid': 'Questo profilo {kind} non è valido: {reason}',
  'profileSection.inspector.title': 'Profilo',
  'profileSection.inspector.unavailable': 'Il profilo può essere modificato su un elemento costruito direttamente da una sezione',
  'profileSection.inspector.dimsNote': 'Le dimensioni di un rettangolo si impostano in Dimensioni',
  'profileSection.inspector.outerSize': 'La dimensione esterna segue la sezione: modificala in Profilo',
  'profileSection.inspector.edit': 'Modifica profilo',
} satisfies Catalogue;
