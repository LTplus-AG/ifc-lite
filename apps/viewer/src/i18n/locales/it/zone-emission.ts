/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const zoneEmissionIt = {
  "zoneEmission.title": "Revisiona generazione delle zone valutate",
  "zoneEmission.hint": "Genera l'intero insieme di zone valutate solo nel modello scelto. L'appartenenza deriva dalla valutazione nativa attuale.",
  "zoneEmission.limit": "Gli output precedenti di questa sessione vengono sostituiti. Le zone importate da un file IFC precedente rimangono. Gli altri modelli restano invariati. Un'anteprima del solido generato non è disponibile.",
  "zoneEmission.prepare": "Prepara generazione nativa delle zone",
  "zoneEmission.apply": "Genera zone revisionate",
  "zoneEmission.population": "{zones} zone, {members} elementi valutati, {replaced} zone precedenti sostituite; {imported} zone importate conservate.",
  "zoneEmission.records": "Record di output nativi",
  "zoneEmission.frame": "Unità native e sistema di coordinate del modello",
  "zoneEmission.receiptProblem": "Il modello è cambiato, ma non è stato possibile salvare la ricevuta. Annulla resta disponibile nel pannello nativo Modifiche."
} satisfies Catalogue;
