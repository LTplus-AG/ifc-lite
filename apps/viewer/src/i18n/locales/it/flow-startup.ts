/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const flowStartupIt = {
  "flowStartup.optIn": "Proponi questo flusso di lavoro all'avvio",
  "flowStartup.title": "Aprire il flusso di lavoro salvato?",
  "flowStartup.description": "Apri “{name}” per scegliere i file e rivedere le impostazioni, poi fai clic su Esegui quando sei pronto.",
  "flowStartup.open": "Apri flusso di lavoro",
  "flowStartup.skip": "Salta per questa sessione",
  "flowStartup.disable": "Disattiva richiesta all'avvio",
  "flowStartup.storageError": "Impossibile salvare la preferenza di avvio: {reason}"
} satisfies Catalogue;
