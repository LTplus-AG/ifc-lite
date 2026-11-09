/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const storeyManagerIt = {
  "storeyManager.title": "Piani",
  "storeyManager.subtitle": "{model} · {count} piani",
  "storeyManager.open": "Gestisci piani…",
  "storeyManager.back": "Torna all’ispettore",
  "storeyManager.undoLabel": "Modifica del piano",
  "storeyManager.addAbove": "Aggiungi piano sopra",
  "storeyManager.addBelow": "Aggiungi piano sotto",
  "storeyManager.addAboveOf": "Aggiungi un piano sopra {storey}",
  "storeyManager.addBelowOf": "Aggiungi un piano sotto {storey}",
  "storeyManager.fallbackName": "Livello {index}",
  "storeyManager.added": "{storey} aggiunto a {elevation} m",
  "storeyManager.renamed": "Rinominato in {storey}",
  "storeyManager.column.name": "Nome",
  "storeyManager.column.elevation": "Quota",
  "storeyManager.column.height": "Altezza interpiano",
  "storeyManager.column.elements": "Elementi",
  "storeyManager.elements": {
    "one": "{count} elemento",
    "many": "{count} elementi",
    "other": "{count} elementi"
  },
  "storeyManager.active": "Disegno qui",
  "storeyManager.activeGroup": "Piano su cui disegnare",
  "storeyManager.activate": "Disegna su {storey}",
  "storeyManager.noStoreyAbove": "Ultimo piano: nessun piano superiore a cui misurare la distanza",
  "storeyManager.field.name": "Nome di {storey}",
  "storeyManager.field.elevation": "Quota di {storey}, in metri",
  "storeyManager.field.height": "Altezza interpiano di {storey}, in metri",
  "storeyManager.field.hint": "Invio applica · Esc annulla",
  "storeyManager.invalid.name": "Il piano deve avere un nome",
  "storeyManager.invalid.length": "Inserisci una lunghezza, ad esempio 3.00, 3,5 o 3500 mm",
  "storeyManager.invalid.height": "Inserisci un’altezza maggiore di zero, ad esempio 3.00 o 3500 mm",
  "storeyManager.mode.elevation": "Sposta solo {storey}; i piani superiori restano fermi",
  "storeyManager.mode.height": "Sposta tutti i piani sopra {storey} della stessa distanza",
  "storeyManager.impact.title": "Cosa cambia",
  "storeyManager.impact.storeys": {
    "one": "Sposta {count} piano",
    "many": "Sposta {count} piani",
    "other": "Sposta {count} piani"
  },
  "storeyManager.impact.elements": {
    "one": "sposta {count} elemento",
    "many": "sposta {count} elementi",
    "other": "sposta {count} elementi"
  },
  "storeyManager.impact.walls": {
    "one": "ridimensiona {count} muro",
    "many": "ridimensiona {count} muri",
    "other": "ridimensiona {count} muri"
  },
  "storeyManager.impact.stairs": {
    "one": "riadatta {count} scala",
    "many": "riadatta {count} scale",
    "other": "riadatta {count} scale"
  },
  "storeyManager.impact.held": {
    "one": "mantiene fermo {count} elemento di un altro piano",
    "many": "mantiene fermi {count} elementi di altri piani",
    "other": "mantiene fermi {count} elementi di altri piani"
  },
  "storeyManager.impact.nothing": "Nessuno spostamento: il piano è già in questa posizione",
  "storeyManager.impact.preview": "Anteprima in 3D e nella pianta prima dell’applicazione",
  "storeyManager.impact.planOnly": "In una stanza condivisa l’anteprima non è visibile a tutti: Invio applica la modifica",
  "storeyManager.notice.wallNotResized": {
    "one": "{count} muro collegato si sposta ma mantiene l’altezza: non è un’estrusione semplice",
    "many": "{count} muri collegati si spostano ma mantengono l’altezza: non sono estrusioni semplici",
    "other": "{count} muri collegati si spostano ma mantengono l’altezza: non sono estrusioni semplici"
  },
  "storeyManager.notice.wallAttachmentUnresolved": {
    "one": "{count} muro mantiene l’altezza: il collegamento superiore registrato non identifica un unico piano",
    "many": "{count} muri mantengono l’altezza: i collegamenti superiori registrati non identificano un unico piano",
    "other": "{count} muri mantengono l’altezza: i collegamenti superiori registrati non identificano un unico piano"
  },
  "storeyManager.notice.wallQuantitiesPartial": {
    "one": "{count} muro ridimensionato ha più insiemi di quantità di base: viene aggiornato solo il primo",
    "many": "{count} muri ridimensionati hanno più insiemi di quantità di base: viene aggiornato solo il primo",
    "other": "{count} muri ridimensionati hanno più insiemi di quantità di base: viene aggiornato solo il primo"
  },
  "storeyManager.notice.stairNotRefit": {
    "one": "{count} scala si sposta ma non viene riadattata: non è una singola rampa a gradini",
    "many": "{count} scale si spostano ma non vengono riadattate: non sono singole rampe a gradini",
    "other": "{count} scale si spostano ma non vengono riadattate: non sono singole rampe a gradini"
  },
  "storeyManager.notice.select": "Selezionali",
  "storeyManager.refusal.spacing": "Non rimane alcuna altezza tra {storey} e {neighbour}",
  "storeyManager.refusal.crossingAbove": "{storey} supererebbe {neighbour} ({neighbourElevation} m) al di sopra",
  "storeyManager.refusal.crossingBelow": "{storey} passerebbe sotto {neighbour} ({neighbourElevation} m)",
  "storeyManager.refusal.topStorey": "{storey} è l’ultimo piano: nessun piano superiore a cui misurare la distanza",
  "storeyManager.refusal.shared": {
    "one": "{count} elemento condivide il posizionamento con un altro piano e non può essere spostato da solo",
    "many": "{count} elementi condividono il posizionamento con altri piani e non possono essere spostati da soli",
    "other": "{count} elementi condividono il posizionamento con altri piani e non possono essere spostati da soli"
  },
  "storeyManager.refusal.unplaced": {
    "one": "{count} elemento ha una geometria ma nessun posizionamento e non può essere spostato",
    "many": "{count} elementi hanno una geometria ma nessun posizionamento e non possono essere spostati",
    "other": "{count} elementi hanno una geometria ma nessun posizionamento e non possono essere spostati"
  },
  "storeyManager.refusal.unreadable": {
    "one": "Il posizionamento di {count} elemento non può essere letto",
    "many": "Il posizionamento di {count} elementi non può essere letto",
    "other": "Il posizionamento di {count} elementi non può essere letto"
  },
  "storeyManager.refusal.onlyStorey": "Un modello deve mantenere almeno un piano",
  "storeyManager.refusal.stale": "Il modello è cambiato dopo la verifica. Controllalo di nuovo prima di confermare.",
  "storeyManager.refusal.tooLarge": "{storey} contiene troppi elementi per una modifica in un’unica operazione",
  "storeyManager.refusal.other": "Non applicato: {reason}",
  "storeyManager.refusal.nothingChanged": "Nessuna modifica effettuata.",
  "storeyManager.delete": "Elimina {storey}",
  "storeyManager.deleted": "{storey} eliminato",
  "storeyManager.undo": "Annulla",
  "storeyManager.undoStale": "Eliminazione non annullata: sono presenti modifiche successive. Annullale prima dalla barra degli strumenti.",
  "storeyManager.delete.title": {
    "one": "{storey} contiene {count} elemento",
    "many": "{storey} contiene {count} elementi",
    "other": "{storey} contiene {count} elementi"
  },
  "storeyManager.delete.moveTo": "Spostali in",
  "storeyManager.delete.move": "Sposta ed elimina",
  "storeyManager.delete.withContents": {
    "one": "Elimina con il suo {count} elemento",
    "many": "Elimina con i suoi {count} elementi",
    "other": "Elimina con i suoi {count} elementi"
  },
  "storeyManager.delete.cancel": "Mantieni piano",
  "storeyManager.strip.label": "Piani in scala",
  "storeyManager.strip.level": "{storey} a {elevation} m",
  "storeyManager.loading": "Lettura dei piani…",
  "storeyManager.empty": "Questo modello non ha ancora piani",
  "storeyManager.addFirst": "Aggiungi un piano a ±0.00",
  "storeyManager.noModel": "Apri un modello nello spazio Modello per gestirne i piani",
  "storeyManager.readOnly": "I piani possono essere elencati ma non modificati: {reason}",
  "storeyManager.error": "Impossibile leggere i piani: {reason}"
} satisfies Catalogue;
