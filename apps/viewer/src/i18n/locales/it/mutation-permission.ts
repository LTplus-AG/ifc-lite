/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const mutationPermissionIt = {
  "mutationPermission.workflowRunning": "Attendi il termine del controllo del workflow o dell'acquisizione PDF, oppure annulla il workflow",
  "mutationPermission.editModeRequired": "Attiva la modalità Modifica per modificare questo modello",
  "mutationPermission.roleRequired": "Per modificare serve l'accesso da editor in questa sessione condivisa",
  "mutationPermission.modelUnavailable": "Questo modello non contiene dati IFC modificabili",
  "mutationPermission.propertiesLoading": "Le proprietà del modello sono ancora in caricamento",
  "mutationPermission.propertiesFailed": "Impossibile caricare le proprietà del modello, quindi non è modificabile",
  "mutationPermission.idSpaceExhausted": "Questo modello ha più entità dello spazio riservato, quindi non può essere modificato in questa sessione",
} satisfies Catalogue;
