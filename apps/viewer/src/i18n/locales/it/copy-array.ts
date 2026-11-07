/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const copyArrayIt = {
  "commands.model.copy": "Copia gli elementi selezionati (spazio Modello)",
  "commands.model.paste": "Incolla gli elementi copiati al cursore (spazio Modello)",
  "commands.model.pasteInPlace": "Incolla gli elementi copiati nella stessa posizione, al piano attuale (spazio Modello)",
  "commands.model.array": "Ripeti gli elementi selezionati in fila o attorno a un centro (spazio Modello)",
  "copyArray.copied": {
    "one": "Copiato {countDisplay} elemento",
    "other": "Copiati {countDisplay} elementi",
    "many": "Copiati {countDisplay} elementi"
  },
  "copyArray.paste.label": "Incolla",
  "copyArray.paste.hint": "Fai clic dove inserire la copia. Per incollare su un altro piano, cambia prima piano",
  "copyArray.paste.empty": "Nessun elemento copiato: seleziona gli elementi e copiali prima",
  "copyArray.paste.stale": "Gli elementi copiati non possono più essere copiati: selezionali e copiali di nuovo",
  "copyArray.paste.otherModel": "Gli elementi copiati sono in un altro modello: incollali lì",
  "copyArray.tool.array": "Serie",
  "copyArray.blocked.array": "Seleziona prima gli elementi da ripetere",
  "copyArray.array.label": "Serie",
  "copyArray.array.noSelection": "Seleziona prima gli elementi da ripetere",
  "copyArray.array.refused": "Questi elementi non possono essere ripetuti: fai clic per vedere perché",
  "copyArray.array.linearStart": "Fai clic dove inizia la direzione",
  "copyArray.array.linearEnd": "Fai clic dove termina: quella distanza è un passo (Spaziatura) o l'intera serie (Adatta)",
  "copyArray.array.polarCentre": "Fai clic sul centro attorno al quale ruotare le copie",
  "copyArray.array.polarCommit": "Fai clic o premi Invio per posizionare le copie",
  "copyArray.field.count": "Conteggio",
  "copyArray.field.spacing": "Spaziatura",
  "copyArray.field.total": "Totale",
  "copyArray.field.angle": "Angolo",
  "copyArray.mode.label": "Tipo di serie",
  "copyArray.mode.linear": "Lineare",
  "copyArray.mode.polar": "Polare",
  "copyArray.fit.label": "Cosa misura la distanza",
  "copyArray.fit.spacing": "Spaziatura",
  "copyArray.fit.fit": "Adatta",
  "copyArray.fit.spacingTitle": "La distanza è il passo da una copia alla successiva",
  "copyArray.fit.fitTitle": "La distanza copre l'intera serie"
} satisfies Catalogue;
