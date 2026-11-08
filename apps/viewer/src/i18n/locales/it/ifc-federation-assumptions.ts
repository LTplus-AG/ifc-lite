/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const ifcFederationAssumptionsIt = {
  "settings.ifcFederation.title": "Federazione IFC",
  "settings.ifcFederation.sharedVertical": "Presumi che i modelli IFC condividano un sistema altimetrico",
  "settings.ifcFederation.hint": "Disattivato per impostazione predefinita. Attivalo solo se sai che i modelli IFC e il modello di ancoraggio usano lo stesso sistema altimetrico. Quando un datum verticale manca o non è risolto, le quote vengono posizionate come definite nel modello. Un'ipotesi errata posiziona i modelli troppo in alto o troppo in basso. I datum dichiarati diversi continuano a essere rifiutati. Anche i nomi non riconosciuti che non possono essere riconciliati vengono rifiutati. Ricarica o riallinea la federazione per applicare le modifiche.",
  "settings.ifcFederation.assumed": "Sistema altimetrico presunto",
  "settings.ifcFederation.appliedUnresolved": "In base alla tua impostazione, si presume che le quote IFC condividano il sistema altimetrico del modello di ancoraggio. Un datum verticale definito nel modello non è stato risolto; le dichiarazioni di origine restano invariate.",
  "settings.ifcFederation.applied": "In base alla tua impostazione, si presume che le quote IFC condividano il sistema altimetrico del modello di ancoraggio. Manca un datum verticale; le dichiarazioni di origine restano invariate.",
} satisfies Catalogue;
