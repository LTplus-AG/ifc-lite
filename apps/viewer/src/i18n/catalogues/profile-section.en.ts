/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The cross-section picker of the Beam, Column and Member commands and the
 * Model inspector's Profile section (charter #6232, D2). Unit symbols stay
 * untranslated.
 */
export const profileSectionEn = {
  'profileSection.kind.Rectangle': 'Rectangle',
  'profileSection.kind.I': 'I / H',
  'profileSection.kind.L': 'Angle (L)',
  'profileSection.kind.T': 'Tee (T)',
  'profileSection.kind.U': 'Channel (U)',
  'profileSection.kind.C': 'Lipped channel (C)',
  'profileSection.kind.Circle': 'Circle',
  'profileSection.kind.RectangleHollow': 'Hollow rectangle',
  'profileSection.kind.CircleHollow': 'Hollow circle',
  'profileSection.field.width': 'Width',
  'profileSection.field.height': 'Height',
  'profileSection.field.depth': 'Depth',
  'profileSection.field.overallWidth': 'Width',
  'profileSection.field.overallDepth': 'Depth',
  'profileSection.field.flangeWidth': 'Flange width',
  'profileSection.field.web': 'Web',
  'profileSection.field.flange': 'Flange',
  'profileSection.field.thickness': 'Thickness',
  'profileSection.field.wall': 'Wall',
  'profileSection.field.girth': 'Lip',
  'profileSection.field.radius': 'Radius',
  'profileSection.fieldAria': '{label} in metres',
  'profileSection.picker.label': 'Section',
  'profileSection.picker.title': 'Choose the cross-section of new elements',
  'profileSection.picker.button': 'Section: {kind}',
  'profileSection.kindAria': 'Section kind',
  'profileSection.previewAria': 'Section preview: {kind}, {across} by {up}',
  'profileSection.invalid': 'This {kind} does not fit: {reason}',
  'profileSection.inspector.title': 'Profile',
  'profileSection.inspector.unavailable': 'The profile can be changed on an element built straight from a section',
  'profileSection.inspector.dimsNote': 'A rectangle is sized in Dimensions',
  'profileSection.inspector.edit': 'Change profile',
} as const satisfies Record<string, TranslationValue>;
