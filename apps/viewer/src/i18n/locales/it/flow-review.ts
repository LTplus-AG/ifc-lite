/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const flowReviewIt = {
  "flowReview.title": "Controlla la proposta dell'IA",
  "flowReview.paused": {
    one: "L'esecuzione si è fermata a {nodes}. Nulla a valle di questo nodo viene eseguito finché non approvi questa proposta.",
    other: "L'esecuzione si è fermata a {nodes}. Nulla a valle di questi nodi viene eseguito finché non approvi questa proposta.",
    many: "L'esecuzione si è fermata a {nodes}. Nulla a valle di questi nodi viene eseguito finché non approvi questa proposta.",
  },
  "flowReview.node": "{node} ({type})",
  "flowReview.digest": "Proposta {digest}",
  "flowReview.created": "Salvata per il controllo {time}",
  "flowReview.coverage.classify": "{rows} righe · {classified} classificate · {unknown} sconosciute · {failed} non riuscite · {notSent} non inviate · {requests} richieste · modello {model}",
  "flowReview.coverage.summarize": "{rows} righe · {sent} inviate · {sections} paragrafi · {uncited} senza citazione · {requests} richieste · modello {model}",
  "flowReview.coverage.extract": "{passages} passaggi · {sent} inviati · {records} record · {unsupported} non supportati · {requests} richieste · modello {model}",
  "flowReview.approve": "Approva e riprendi",
  "flowReview.resume": "Riprendi",
  "flowReview.reject": "Rifiuta",
  "flowReview.dismiss": "Chiudi",
  "flowReview.state.prepared": "Nulla a valle è stato eseguito. Approva per continuare l'esecuzione esattamente con questa proposta, oppure rifiutala.",
  "flowReview.state.reviewed": "Approvata. Riprendi esegue il resto del grafo esattamente da questa proposta.",
  "flowReview.state.applying": "Ripresa dalla proposta approvata…",
  "flowReview.state.completed": "Ripresa dalla proposta approvata. I nodi completati prima della pausa sono stati ripristinati, non rieseguiti, e per questa proposta non è stata inviata alcuna nuova richiesta all'IA.",
  "flowReview.state.partial": "La ripresa non è stata completata ({reason}). Gli effetti a valle potrebbero essere parziali; questa proposta non può essere ripresa di nuovo. Esegui di nuovo il grafo per un nuovo controllo.",
  "flowReview.state.rejected": "Rifiutata. Nulla a valle della proposta è stato eseguito.",
  "flowReview.refused.graph-changed": "Il grafo o i suoi input del Modulo sono cambiati dopo la creazione di questa proposta. Esegui di nuovo il grafo per un nuovo controllo.",
  "flowReview.refused.sources-changed": "I modelli o le loro modifiche sono cambiati dopo la creazione di questa proposta. Esegui di nuovo il grafo per un nuovo controllo.",
  "flowReview.refused.other": "Questa proposta non può essere ripresa: {reason}",
  "flowReview.notSaved": "Non è stato possibile salvare la proposta per il controllo, quindi nulla a valle è stato eseguito: {reason}",
  "flowReview.needsModel": "I nodi IA usano il modello scelto per l'Assistente. Scegli un modello, o aggiungi una chiave per esso, per eseguire questo grafo.",
} satisfies Catalogue;
