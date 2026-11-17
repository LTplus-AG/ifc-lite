/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const remeshIt = {
  'remesh.refused.noSource': 'Le forme 3D di questo modello non possono essere ricostruite dopo le modifiche: il modello non è stato caricato da un file IFC.',
  'remesh.refused.noFrame': 'Le forme 3D di questo modello non possono essere ricostruite dopo le modifiche: il modello è stato caricato senza il sistema di coordinate del motore. Ricaricalo per abilitare gli aggiornamenti.',
  'remesh.refused.colourMerged': 'L’elemento modificato condivide una mesh con altri elementi, quindi la sua forma 3D non può essere ricostruita singolarmente. La modifica viene conservata.',
  'remesh.refused.unreadable': 'Non è stato possibile rileggere i dati dell’elemento modificato, quindi la sua forma 3D non è stata ricostruita. La modifica viene conservata.',
  'remesh.refused.alignment': 'Il modello dell’elemento modificato è allineato al sistema di coordinate di un altro modello e la forma ricostruita non ha potuto essere allineata allo stesso modo. La modifica viene conservata.',
  'remesh.failed': 'Non è stato possibile ricostruire la forma 3D dell’elemento modificato: {message}. La modifica viene conservata.',
} satisfies Catalogue;
