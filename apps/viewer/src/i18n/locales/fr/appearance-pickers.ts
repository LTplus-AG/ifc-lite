/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const appearancePickersFr = {
  'appearance.scan.surfaceSource': '{model} · Surface {number}',
  'appearance.scan.pointCloudSource': '{model} · Nuage de points ({retained} points conservés sur {seen})',
  'appearance.facePicker.error.miss': 'Aucune surface visible sous le pointeur.',
  'appearance.facePicker.error.differentSurface': 'Choisissez une face de l’objet ouvert dans l’éditeur de faces.',
  'appearance.facePicker.error.ambiguous': 'Cette face rendue n’a pas d’identité source exacte. Rechargez le modèle et réessayez.',
  'appearance.facePicker.error.busy': 'Attendez la fin de l’aperçu d’apparence en cours.',
} satisfies Catalogue;
