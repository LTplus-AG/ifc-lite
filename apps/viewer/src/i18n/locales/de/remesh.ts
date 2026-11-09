/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const remeshDe = {
  "remesh.refused.noSource": "Die 3D-Formen dieses Modells können nach Bearbeitungen nicht neu erstellt werden: Es wurde nicht aus einer IFC-Datei geladen.",
  "remesh.refused.noFrame": "Die 3D-Formen dieses Modells können nach Bearbeitungen nicht wiederhergestellt werden: Es wurde ohne den Koordinatenrahmen der Engine geladen. Laden Sie es neu, um Updates zu aktivieren.",
  "remesh.refused.colourMerged": "Das bearbeitete Bauteil teilt ein Netz mit anderen Bauteilen, sodass seine 3D-Form nicht alleine neu erstellt werden kann. Die Bearbeitung bleibt erhalten.",
  "remesh.refused.unreadable": "Die Daten des bearbeiteten Bauteils konnten nicht zurückgelesen werden, daher wurde seine 3D-Form nicht neu erstellt. Die Bearbeitung bleibt erhalten.",
  "remesh.refused.alignment": "Das Modell des bearbeiteten Bauteils ist am Koordinatensystem eines anderen Modells ausgerichtet und die neu erstellte Form konnte nicht auf die gleiche Weise ausgerichtet werden. Die Bearbeitung bleibt erhalten.",
  "remesh.failed": "Die 3D-Form des bearbeiteten Bauteils konnte nicht wiederhergestellt werden: {message}. Die Bearbeitung bleibt erhalten.",
} satisfies Catalogue;
