/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const alignmentSectionIt = {
  "alignmentSection.mode": "Tracciato",
  "alignmentSection.model": "Modello del tracciato",
  "alignmentSection.axis": "Scegli IfcAlignment",
  "alignmentSection.axisFallback": "IfcAlignment #{id}",
  "alignmentSection.noAxes": "Nessun IfcAlignment",
  "alignmentSection.loading": "Risoluzione del tracciato…",
  "alignmentSection.distance": "Distanza orizzontale dall'inizio",
  "alignmentSection.approximate": "Curva approssimata · distanza dall'inizio",
  "alignmentSection.help": "La distanza è misurata geometricamente in metri orizzontali dall'inizio fisico, non è la progressiva definita nel modello. Il piano segue la tangente calcolata. Trascinare il piano lo stacca dal tracciato; scegli di nuovo il tracciato per riagganciarlo.",
  "alignmentSection.error": "Impossibile sezionare questo tracciato: {detail}",
} satisfies Catalogue;
