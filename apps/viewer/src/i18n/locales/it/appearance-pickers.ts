/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const appearancePickersIt = {
  'appearance.scan.surfaceSource': '{model} · Superficie {number}',
  'appearance.scan.pointCloudSource': '{model} · Nuvola di punti ({retained} di {seen} punti conservati)',
  'appearance.facePicker.error.miss': 'Nessuna superficie visibile sotto il puntatore.',
  'appearance.facePicker.error.differentSurface': 'Scegli una faccia dell’oggetto aperto nell’editor delle facce.',
  'appearance.facePicker.error.ambiguous': 'Questa faccia renderizzata non ha un’identità di origine esatta. Ricarica il modello e riprova.',
  'appearance.facePicker.error.busy': 'Attendi il completamento dell’anteprima dell’aspetto in corso.',
} satisfies Catalogue;
