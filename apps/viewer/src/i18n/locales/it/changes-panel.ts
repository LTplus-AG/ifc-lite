/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const changesPanelIt = {
  "changesPanel.title": "Modifiche",
  "changesPanel.close": "Chiudi Modifiche",
  "changesPanel.empty": "Nessuna operazione di modifica registrata.",
  "changesPanel.rowCount": { one: "{count} modifica", other: "{count} modifiche", many: "{count} modifiche" },
  "changesPanel.entity": "{type} #{id}",
  "changesPanel.georeference": "Georeferenziazione",
  "changesPanel.modelMetadata": "Metadati del modello",
  "changesPanel.jump": "Vai a {entity} in {model}",
  "changesPanel.revert": "Annulla modifica",
  "changesPanel.revertUnavailable": "Questa modifica non può essere annullata in sicurezza finché modifiche più recenti dipendono da essa.",
  "changesPanel.revertStale": "La modifica è cambiata. Controlla l'elenco attuale e riprova.",
  "changesPanel.revertPermission": "Attiva la modalità Modifica o chiedi l'accesso in modifica prima di annullare la modifica.",
  "changesPanel.revertSharedRoom": "Esci dalla stanza condivisa prima di annullare una modifica. La stanza non può ancora sincronizzare questo annullamento.",
  "changesPanel.revertUnsupported": "Questa modifica non può essere annullata dal pannello. Usa Annulla quando è il passaggio più recente.",
} satisfies Catalogue;
