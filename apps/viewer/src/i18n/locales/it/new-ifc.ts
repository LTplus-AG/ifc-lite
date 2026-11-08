/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const newIfcIt = {
  "newIfc.title": "Revisiona nuovo file IFC",
  "newIfc.scope": "Crea solo un nuovo progetto, Site/Building nativi e i piani forniti. Unità e quote devono essere fornite; non vengono dedotte geometrie di elementi né requisiti di progetto.",
  "newIfc.noUndo": "Questa operazione crea un file separato. Scaricare un file e sostituire una sessione del visualizzatore non sono modifiche di creazione e non dispongono dell'annullamento delle modifiche al modello.",
  "newIfc.prepare": "Prepara nuovo file IFC",
  "newIfc.preparing": "Preparazione del file nativo…",
  "newIfc.preview": "{name}: {bytes} byte, {count} record nativi; {schema}, {unit}.",
  "newIfc.defaults": "Identità, nomi e valori predefiniti nativi",
  "newIfc.content": "Contenuto IFC preparato esatto",
  "newIfc.download": "Scarica IFC revisionato",
  "newIfc.downloaded": "I byte approvati sono stati pubblicati tramite l'azione nativa di download.",
  "newIfc.loadWarning": "Richiedere un caricamento primario sostituisce la sessione attuale del visualizzatore. Salva prima le modifiche attuali. Il caricamento nativo può comunque non riuscire o essere annullato.",
  "newIfc.requestLoad": "Richiedi caricamento nel visualizzatore (sostituisce la sessione)",
  "newIfc.requested": "Caricamento richiesto, non confermato. Segui i rapporti nativi di Attività e Caricamento per l'esito effettivo.",
  "newIfc.modelsTitle": "Modelli e nuovi file IFC",
  "newIfc.modelsDescription": "Discuti rapporti effettivi di caricamento dei modelli, oppure prepara una struttura IFC nativa autonoma da schema, unità e piani forniti.",
  "newIfc.capabilityReady": "Struttura nativa per nuovo file disponibile; nessun dato fattuale sui modelli caricati",
  "newIfc.suggest": "Prepara un nuovo progetto IFC nativo con piani usando schema, unità e quote che fornisco; chiedi gli input mancanti."
} satisfies Catalogue;
