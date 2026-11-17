/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const changeSetsIt = {
  "changeSets.panel.title": "Insiemi di modifiche",
  "changeSets.panel.close": "Chiudi Insiemi di modifiche",
  "changeSets.panel.count": {
    "one": "{count} insieme",
    "other": "{count} insiemi",
    "many": "{count} insiemi"
  },
  "changeSets.panel.intro": "Le nuove modifiche vengono inserite nell'insieme di modifiche attivo. Esportane uno per condividerlo come file.",
  "changeSets.empty": "Nessun insieme di modifiche finora. La prima modifica ne crea uno chiamato \"Unsaved changes\", oppure puoi crearne uno ora.",
  "changeSets.noActive": "Nessun insieme di modifiche attivo. La prossima modifica avvia \"Unsaved changes\".",
  "changeSets.defaultName": "Insieme di modifiche {number}",
  "changeSets.new": "Nuovo",
  "changeSets.newTitle": "Nuovo insieme di modifiche",
  "changeSets.newDescription": "Assegna un nome all'insieme di modifiche. Le nuove modifiche verranno inserite al suo interno.",
  "changeSets.import": "Importa",
  "changeSets.importFailed": "{file} non è un file di insieme di modifiche.",
  "changeSets.importDone": "Importato {name}.",
  "changeSets.row.edits": {
    "one": "{count} modifica",
    "other": "{count} modifiche",
    "many": "{count} modifiche"
  },
  "changeSets.row.created": "Creato {time}",
  "changeSets.row.active": "Attivo",
  "changeSets.row.setActive": "Imposta come attivo",
  "changeSets.row.activate": "Imposta come attivo: {name}",
  "changeSets.row.deactivate": "Attivo: {name}. Premi per interrompere la raccolta delle modifiche al suo interno",
  "changeSets.row.show": "Mostra le modifiche in {name}",
  "changeSets.row.hide": "Nascondi le modifiche in {name}",
  "changeSets.row.rename": "Rinomina {name}",
  "changeSets.row.export": "Esporta {name}",
  "changeSets.row.discard": "Scarta {name}",
  "changeSets.renameTitle": "Rinomina insieme di modifiche",
  "changeSets.renameDescription": "Nuovo nome per {name}.",
  "changeSets.discardTitle": "Scarta insieme di modifiche",
  "changeSets.discardDescription": "Scartare {name} e il suo registro di {count} modifiche? Le modifiche restano nel modello; viene rimosso solo questo elenco.",
  "changeSets.discardConfirm": "Scarta",
  "changeSets.contents.empty": "Nessuna modifica in questo insieme finora.",
  "changeSets.contents.entity": "{type} #{id}",
  "changeSets.contents.modelLevel": "Modifiche all'intero modello",
  "changeSets.contents.select": "Seleziona {entity} in {model}",
  "changeSets.contents.edits": {
    "one": "{count} modifica",
    "other": "{count} modifiche",
    "many": "{count} modifiche"
  },
  "changeSets.contents.created": "Creato",
  "changeSets.contents.deleted": "Eliminato",
  "changeSets.contents.retyped": "Classe cambiata",
  "changeSets.rail.label": "Insiemi di modifiche",
  "changeSets.rail.active": "Attivo: {name}",
  "changeSets.rail.none": "Nessun insieme di modifiche attivo"
} satisfies Catalogue;
