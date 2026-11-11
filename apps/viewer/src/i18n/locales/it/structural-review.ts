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
  "structuralReview.op.structural.group.assign": "Assegna oggetti forniti al gruppo",
  "structuralReview.derive.title": "Derivare il modello di analisi strutturale",
  "structuralReview.derive.hint": "Travi, pilastri e aste diventano elementi lineari; solai e muri diventano elementi superficiali sul piano medio; le estremità che si incontrano condividono un nodo; le fondazioni portano i vincoli. Ogni elemento derivato è collegato al suo elemento fisico. Vengono creati record IFC; il progetto non viene verificato.",
  "structuralReview.derive.prepare": "Deriva e verifica",
  "structuralReview.derive.acknowledgement": "Ho verificato gli elementi saltati e i vincoli ipotizzati.",
  "structuralReview.derive.counts": "{curveMembers} elementi lineari · {surfaceMembers} elementi superficiali · {nodes} nodi · {supports} vincoli, di cui {guessedSupports} ipotizzati · {created} record IFC da creare",
  "structuralReview.derive.assumed": "{count} elementi non hanno un valore LoadBearing e sono considerati portanti.",
  "structuralReview.derive.skipped": "Elementi saltati ({count})",
  "structuralReview.derive.guessed": "Vincoli ipotizzati ai nodi più bassi, perché nessuna fondazione ne porta uno ({count})",
  "structuralReview.derive.unconnected": "Estremità che toccano un elemento o una superficie senza esservi collegate ({count})",
  "structuralReview.derive.existing": "Questo modello ha già un modello di analisi derivato (#{id}). Non viene derivato una seconda volta.",
  "structuralReview.derive.nothing": "Niente da derivare: nessun elemento portante è stato idealizzato, oppure ognuno ha già un corrispondente strutturale.",
  "structuralReview.derive.noModel": "Carica un modello per derivarne il modello di analisi strutturale.",
  "structuralReview.derive.nodeAt": "Nodo {node}: {position} m",
  "structuralReview.derive.endAt": "Nodo {node}: {position} m, {landsOn} #{element}",
  "structuralReview.derive.more": "Altri {count} non mostrati",
} satisfies Catalogue;
