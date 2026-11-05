/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const appearancePickersDe = {
  "appearance.scan.surfaceSource": "{model} · Oberfläche {number}",
  "appearance.scan.pointCloudSource": "{model} · Punktwolke ({retained} der {seen}-Punkte bleiben erhalten)",
  "appearance.facePicker.error.miss": "Keine sichtbare Fläche unter dem Zeiger.",
  "appearance.facePicker.error.differentSurface": "Wählen Sie eine Fläche auf dem im Flächeneditor geöffneten Objekt aus.",
  "appearance.facePicker.error.ambiguous": "Diese dargestellte Fläche hat keine eindeutige Quellenidentität. Laden Sie das Modell neu und versuchen Sie es erneut.",
  "appearance.facePicker.error.busy": "Warten Sie, bis die Vorschau des aktuellen Erscheinungsbilds abgeschlossen ist.",
} satisfies Catalogue;
