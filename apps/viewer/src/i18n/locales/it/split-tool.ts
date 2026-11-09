/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const splitToolIt = {
  'splitTool.barLabel': 'Dividi',
  'splitTool.hint': 'Punta l’elemento selezionato per posizionare il taglio · digita una distanza o una % · Esc per uscire',
  'splitTool.unitMetres': 'm',
  'splitTool.cutDistanceAria': 'Distanza di taglio in metri, o percentuale della lunghezza dell’elemento',
  'splitTool.unavailable.type': 'Dividi funziona su muri, travi, pilastri, membrature, solette, coperture, lastre e spazi',
  'splitTool.unavailable.storey': 'Impossibile dividere: l’elemento non è contenuto in un piano dell’edificio',
  'splitTool.unavailable.container': 'Impossibile dividere: l’elemento si trova direttamente nell’edificio o nel sito, non su un piano. Spostalo prima su un piano',
  'splitTool.unavailable.noBody': 'Impossibile dividere: l’elemento non ha una geometria del corpo',
  'splitTool.unavailable.mesh': 'Impossibile dividere: la geometria è una mesh o una B-rep, non un’estrusione di profilo',
  'splitTool.unavailable.mapped': 'Impossibile dividere: la geometria è condivisa con il suo tipo (rappresentazione mappata)',
  'splitTool.unavailable.boolean': 'Impossibile dividere: la geometria è un solido ritagliato da un’operazione booleana',
  'splitTool.unavailable.profile': 'Impossibile dividere: il profilo di estrusione non è un rettangolo',
  'splitTool.unavailable.shape': 'Impossibile dividere: il posizionamento o la disposizione della rappresentazione non è supportato',
  'splitTool.unavailable.kind': 'Impossibile dividere: questo metodo di divisione non si applica a questo elemento',
  'splitTool.failed': 'Divisione non riuscita: {reason}',
} satisfies Catalogue;
