/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantSourcesIt = {
  "assistantSources.groupChecks": "Controlli",
  "assistantSources.groupCoordination": "Coordinamento",
  "assistantSources.groupQuantities": "Quantità",
  "assistantSources.groupModel": "Modello",
  "assistantSources.groupAutomation": "Automazione",
  "assistantSources.unsupportedTitle": "Non discutibile",
  "assistantSources.unsupportedHint": "Questi pannelli non hanno risultati di analisi nativi da allegare.",
  "assistantSources.boundaryAppearance": "Impostazioni di stile della visualizzazione, non un risultato di analisi.",
  "assistantSources.boundaryModel": "Strumenti di creazione. Discuti le modifiche tramite Modifiche o Insiemi di modifiche.",
  "assistantSources.boundaryExtensions": "Estensioni installate e relative autorizzazioni. Discuti l'output di un'estensione nel pannello che lo mostra.",
  "assistantSources.boundaryCollab": "Elenco dei partecipanti e autorizzazioni della sessione in tempo reale; non esiste un risultato di analisi.",
  "assistantSources.boundarySources": "Connessioni cloud e recupero dati. Credenziali e autorizzazioni degli endpoint non sono mai evidenze.",
  "assistantSources.boundaryPresentation": "Viste della fotocamera salvate per le presentazioni; non esiste un risultato di analisi.",
  "assistantSources.boundaryAssistant": "L'Assistente stesso. Le conversazioni salvate si riaprono, non si allegano come evidenze.",
  "assistantSources.boundaryEnvironment": "Impostazioni di visualizzazione di cielo, illuminazione e ora solare. Non viene registrata alcuna analisi solare e le impostazioni di visualizzazione non misurano le prestazioni di illuminazione naturale.",
  "assistantSources.boundaryIdsStudio": "Creazione IDS. Modificare un documento di requisiti non produce risultati di analisi; eseguilo in Validazione per discuterne i rilievi.",
  "assistantSources.boundaryInflux": "Telemetria sperimentale InfluxDB. Le letture vengono recuperate con un token valido solo per la sessione e non sono condivise con l'assistente."
} satisfies Catalogue;
