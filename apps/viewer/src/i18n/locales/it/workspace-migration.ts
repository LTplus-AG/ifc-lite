/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const workspaceMigrationIt = {
  'workspaceMigration.layout.title': 'Rivedi il layout aggiornato',
  'workspaceMigration.layout.summary': 'Modifiche al layout pronte da rivedere: {count}. Il lavoro salvato viene conservato.',
  'workspaceMigration.layout.showChanges': 'Mostra modifiche',
  'workspaceMigration.layout.hideChanges': 'Nascondi modifiche',
  'workspaceMigration.layout.keep': 'Mantieni layout',
  'workspaceMigration.layout.reset': 'Ripristina layout',
  'workspaceMigration.layout.added': 'Aggiunto {panel} dopo {anchor}.',
  'workspaceMigration.layout.addedTop': 'Aggiunto {panel} all’elenco dei pannelli.',
  'workspaceMigration.layout.renamed': '{from} rinominato in {panel}.',
  'workspaceMigration.layout.restored': '{panel} ripristinato nell’elenco dei pannelli.',
  'workspaceMigration.layout.preserved': 'Posizionamento non disponibile {id} conservato per un uso successivo.',
  'workspaceMigration.layout.regrouped': 'Gruppi di pannelli aggiornati.',
  'workspaceMigration.layout.mode': 'Modalità della barra laterale aggiornata.',
  'workspaceMigration.layout.unreadable': 'Non è stato possibile leggere il layout salvato. L’originale viene conservato per il ripristino.',
  'workspaceMigration.placement.title': 'Posizionamenti di estensioni non disponibili',
  'workspaceMigration.placement.notRendered': 'Il visualizzatore non ha alcuna superficie per {slot}. Il posizionamento viene conservato.',
  'workspaceMigration.placement.hostOwned': 'Il visualizzatore gestisce {slot}; le estensioni non possono sostituire questa superficie.',
  'workspaceMigration.placement.unknownSlot': 'Lo slot {slot} è sconosciuto. Il posizionamento viene conservato.',
  'workspaceMigration.deepLink.copy': 'Copia link',
  'workspaceMigration.deepLink.copyNamed': 'Copia link a {name}',
  'workspaceMigration.deepLink.copied': 'Link copiato',
  'workspaceMigration.deepLink.copyFailed': 'Non è stato possibile copiare il link.',
  'workspaceMigration.deepLink.failed': 'Non è stato possibile aprire l’elemento collegato.',
  'workspaceMigration.deepLink.busy': 'Attendi il completamento della richiesta in corso, poi apri di nuovo il link.',
  'workspaceMigration.deepLink.unavailable': 'L’elemento collegato non è disponibile in questo browser.',
  'workspaceMigration.deepLink.missingConversation': 'Questa conversazione salvata non è stata trovata in questo browser.',
  'workspaceMigration.deepLink.missingReceipt': 'La ricevuta di questa richiesta non è stata trovata in questa sessione.',
  'workspaceMigration.deepLink.missingBcfDraft': 'Questa bozza BCF non è stata trovata in questo browser.',
  'workspaceMigration.deepLink.unknownPanel': 'Il link indica un pannello sconosciuto.',
  'workspaceMigration.deepLink.conflicting': 'Il link contiene destinazioni in conflitto.',
  'workspaceMigration.deepLink.invalidId': 'Il link contiene un identificatore di voce non valido.',
} satisfies Catalogue;
