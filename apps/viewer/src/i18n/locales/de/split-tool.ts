/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const splitToolDe = {
  'splitTool.barLabel': 'Teilen',
  'splitTool.hint': 'Zeigen Sie auf das ausgewählte Bauteil, um den Schnitt zu setzen · Abstand oder % eingeben · Esc zum Beenden',
  'splitTool.unitMetres': 'm',
  'splitTool.cutDistanceAria': 'Schnittabstand in Metern oder als Prozentsatz der Bauteillänge',
  'splitTool.unavailable.type': 'Teilen funktioniert bei Wänden, Balken, Stützen, Stäben, Decken, Dächern, Platten und Räumen',
  'splitTool.unavailable.storey': 'Teilen nicht möglich: Das Bauteil ist keinem Geschoss zugeordnet',
  'splitTool.unavailable.container': 'Teilen nicht möglich: Das Bauteil liegt direkt im Gebäude oder Grundstück, nicht in einem Geschoss. Verschieben Sie es zuerst in ein Geschoss',
  'splitTool.unavailable.noBody': 'Teilen nicht möglich: Das Bauteil hat keine Körpergeometrie',
  'splitTool.unavailable.mesh': 'Teilen nicht möglich: Die Geometrie ist ein Netz oder B-Rep, keine Profilextrusion',
  'splitTool.unavailable.mapped': 'Teilen nicht möglich: Die Geometrie wird mit dem Typ geteilt (gemappte Darstellung)',
  'splitTool.unavailable.boolean': 'Teilen nicht möglich: Die Geometrie ist ein durch Boolesche Operation beschnittener Körper',
  'splitTool.unavailable.profile': 'Teilen nicht möglich: Das Extrusionsprofil ist kein Rechteck',
  'splitTool.unavailable.shape': 'Teilen nicht möglich: Die Platzierung oder der Aufbau der Darstellung wird nicht unterstützt',
  'splitTool.unavailable.kind': 'Teilen nicht möglich: Diese Teilungsmethode gilt nicht für dieses Bauteil',
  'splitTool.failed': 'Teilen fehlgeschlagen: {reason}',
} satisfies Catalogue;
