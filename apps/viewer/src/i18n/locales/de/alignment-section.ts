/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const alignmentSectionDe = {
  'alignmentSection.mode': 'Achse',
  'alignmentSection.model': 'Achsmodell',
  'alignmentSection.axis': 'IfcAlignment auswählen',
  'alignmentSection.axisFallback': 'IfcAlignment #{id}',
  'alignmentSection.noAxes': 'Kein IfcAlignment',
  'alignmentSection.loading': 'Achse wird ermittelt …',
  'alignmentSection.distance': 'Horizontaler Abstand vom Anfang',
  'alignmentSection.approximate': 'Angenäherte Kurve · Abstand vom Anfang',
  'alignmentSection.help': 'Der Abstand wird geometrisch in horizontalen Metern ab dem physischen Anfang gemessen, nicht als erfasste Stationierung. Die Ebene folgt der berechneten Tangente. Wenn Sie die Ebene ziehen, wird sie von der Achse gelöst; wählen Sie die Achse erneut, um fortzufahren.',
  'alignmentSection.error': 'Diese Achse kann nicht geschnitten werden: {detail}',
} satisfies Catalogue;
