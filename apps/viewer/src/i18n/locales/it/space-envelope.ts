/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const spaceEnvelopeIt = {
  "spaceEnvelope.label": "Modifica l'involucro dello spazio",
  "spaceEnvelope.mode": "Forma del soffitto",
  "spaceEnvelope.flat": "Orizzontale",
  "spaceEnvelope.slope": "Inclinato",
  "spaceEnvelope.pitched": "A due falde",
  "spaceEnvelope.floor": "Quota del pavimento",
  "spaceEnvelope.left": "Quota della gronda sinistra",
  "spaceEnvelope.right": "Quota della gronda destra",
  "spaceEnvelope.ridge": "Quota del colmo",
  "spaceEnvelope.pick": "Usa una vista frontale o di sezione. Fai clic su una maniglia del pavimento, della gronda o del colmo; sposta e fai clic per applicare. Invio applica le quote digitate. Alt sospende lo snap.",
  "spaceEnvelope.move": "Spostati su un bordo o un vertice della copertura per agganciarti; un clic o Invio applica una modifica. Esc annulla.",
  "spaceEnvelope.refused": "Seleziona uno spazio con un'estrusione verticale rettangolare o poligonale. Usa una vista verticale lungo la pendenza della copertura. Le geometrie mesh, mappate, con fori, inclinate o illeggibili non possono essere modificate.",
  "spaceEnvelope.invalid": "Mantieni il soffitto sopra il pavimento e il colmo tra le gronde. Un soffitto a due falde deve salire fino al colmo.",
} satisfies Catalogue;
