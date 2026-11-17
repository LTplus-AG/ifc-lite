/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const spaceEnvelopeDe = {
  'spaceEnvelope.label': 'Raumhülle bearbeiten',
  'spaceEnvelope.mode': 'Deckenform',
  'spaceEnvelope.flat': 'Flach',
  'spaceEnvelope.slope': 'Geneigt',
  'spaceEnvelope.pitched': 'Satteldach',
  'spaceEnvelope.floor': 'Bodenhöhe',
  'spaceEnvelope.left': 'Traufhöhe links',
  'spaceEnvelope.right': 'Traufhöhe rechts',
  'spaceEnvelope.ridge': 'Firsthöhe',
  'spaceEnvelope.pick': 'Verwenden Sie eine Vorder- oder Schnittansicht. Klicken Sie auf einen Boden-, Trauf- oder Firstgriff; bewegen und klicken Sie, um die Änderung anzuwenden. Enter übernimmt eingegebene Höhen. Alt setzt das Fangen aus.',
  'spaceEnvelope.move': 'Bewegen Sie den Zeiger zu einer Dachkante oder einem Eckpunkt, um zu fangen; Klicken oder Enter wendet eine Änderung an. Escape bricht ab.',
  'spaceEnvelope.refused': 'Wählen Sie einen Raum mit vertikaler Rechteck- oder Polygonextrusion. Verwenden Sie eine vertikale Ansicht entlang der Dachneigung. Netz-, gemappte, gelochte, geneigte und nicht lesbare Geometrie kann nicht bearbeitet werden.',
  'spaceEnvelope.invalid': 'Die Decke muss über dem Boden und der First zwischen den Traufen liegen. Eine Satteldachdecke muss zum First hin ansteigen.',
} satisfies Catalogue;
