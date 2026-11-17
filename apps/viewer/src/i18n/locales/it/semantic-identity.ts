/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const semanticIdentityIt = {
  'semantic.identityControls': 'Strategia di identità IFC',
  'semantic.identityUri': 'L’URI della risorsa contiene il GlobalId IFC',
  'semantic.identityUriMode': 'Corrispondenza dell’URI della risorsa',
  'semantic.identityUriTemplateMode': 'Modello di URI completo',
  'semantic.identityUriSegmentMode': 'Ultimo segmento del percorso (su attivazione)',
  'semantic.identityUriTemplate': 'Modello di URI completo della risorsa',
  'semantic.identityUriApply': 'Applica modello di URI',
  'semantic.identityUriHint': 'Il modello usa un solo segnaposto {GlobalId}. L’ultimo segmento del percorso richiede URI di risorsa noti per le interrogazioni inverse. La corrispondenza dell’URI non sostituisce mai la strategia diretta GlobalId selezionata.',
  'semantic.identityDirect': 'GlobalId IFC e revisione del modello',
  'semantic.identityLinks': 'Collegamenti espliciti alle risorse',
  'semantic.identityProfile': 'Campi di identità del profilo',
  'semantic.identityGuidField': 'Campo GlobalId del profilo',
  'semantic.identityRevisionField': 'Campo revisione del profilo',
  'semantic.identityNoRevision': 'Nessun campo revisione',
  'semantic.identityLinkJson': 'Collegamenti alle risorse (JSON)',
  'semantic.identityApplyLinks': 'Applica collegamenti alle risorse',
  'semantic.identityLinkHint': 'Usa resourceId, modelRevision e GlobalId. Le revisioni del modello richiedono un’associazione esplicita a un modello caricato.',
} satisfies Catalogue;
