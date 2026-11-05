/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralReviewIt = {
  "structuralReview.title": "Revisiona grafo analitico fornito",
  "structuralReview.hint": "Revisiona solo geometria, vincoli e componenti di carico forniti. Questa operazione crea record IFC; non risolve né valida un progetto ingegneristico. Seleziona le operazioni, poi esamina tutte le modifiche native prima di Applica.",
  "structuralReview.prepare": "Revisiona operazioni strutturali selezionate",
  "structuralReview.references": "Destinazione nativa: {target} · record correlati: {related}",
  "structuralReview.acknowledgement": "Confermo che i valori di carico e rigidezza sono forniti nelle misure native del modello. Non si presume alcuna conversione né dichiarazione di unità mancante.",
  "structuralReview.previewUnavailable": "Un'anteprima della geometria analitica non è disponibile qui. Esamina i record IFC nativi prima di Applica.",
  "structuralReview.population": "{records} record di origine revisionati · {created} creati · {modified} modificati · {deleted} eliminati. Le identità IFC create vengono assegnate con Applica.",
  "structuralReview.units": "Esamina unità native dichiarate e dichiarazioni non disponibili",
  "structuralReview.nativeChanges": "Esamina modifiche IFC native, inclusi riferimenti condivisi ed eliminazioni",
  "structuralReview.receiptProblem": "Le modifiche sono state applicate, ma non è stato possibile salvarne la ricevuta. La cronologia nativa contiene ancora le modifiche.",
  "structuralReview.op.structural.analysis.create": "Crea modello analitico",
  "structuralReview.op.structural.member.create": "Crea membratura analitica curva",
  "structuralReview.op.structural.connection.create": "Crea connessione analitica puntuale",
  "structuralReview.op.structural.group.create": "Crea gruppo di carichi fornito",
  "structuralReview.op.structural.pointAction.create": "Crea azione puntuale fornita",
  "structuralReview.op.structural.linearAction.create": "Crea azione lineare fornita",
  "structuralReview.op.structural.member.connect": "Collega membratura e connessione",
  "structuralReview.op.structural.activity.connect": "Collega attività fornita all'oggetto",
  "structuralReview.op.structural.group.assign": "Assegna oggetti forniti al gruppo"
} satisfies Catalogue;
