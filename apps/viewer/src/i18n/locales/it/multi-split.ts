/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const multiSplitIt = {
  "multiSplit.label": "Dividi lungo una linea",
  "multiSplit.tool": "Dividi lungo una linea",
  "commands.model.splitMulti": "Dividi tutto lungo una linea (spazio Modello)",
  "multiSplit.hintStart": "Fai clic sul primo punto della linea di taglio · la selezione o il piano vengono divisi lungo di essa · Esc per uscire",
  "multiSplit.hintEnd": "Fai clic sul secondo punto o premi Invio per dividere ciò che la linea attraversa · Backspace ricomincia la linea · Esc ricomincia",
  "multiSplit.noTargets": "Niente da dividere qui: seleziona elementi o scegli un piano con muri, travi o solai",
  "multiSplit.needLine": "Disegna prima la linea di taglio: due punti",
  "multiSplit.crossesNothing": "La linea non attraversa nulla che possa dividere",
  "multiSplit.nothingSplittable": "Tutto ciò che la linea attraversa viene rifiutato: nulla verrebbe diviso",
  "multiSplit.scope.selection": {
    "one": "Selezione: {countDisplay} elemento",
    "other": "Selezione: {countDisplay} elementi",
    "many": "Selezione: {countDisplay} elementi"
  },
  "multiSplit.scope.storey": {
    "one": "Piano: {countDisplay} muro, trave o solaio",
    "other": "Piano: {countDisplay} muri, travi e solai",
    "many": "Piano: {countDisplay} muri, travi e solai"
  },
  "multiSplit.bar.splits": {
    "one": "{countDisplay} verrà diviso",
    "other": "{countDisplay} verranno divisi",
    "many": "{countDisplay} verranno divisi"
  },
  "multiSplit.bar.refused": {
    "one": "{countDisplay} rifiutato",
    "other": "{countDisplay} rifiutati",
    "many": "{countDisplay} rifiutati"
  },
  "multiSplit.refused.otherModel": "Appartiene a un modello diverso da quello in modifica",
  "multiSplit.refused.column": "Impossibile dividere: un taglio verticale non attraversa una colonna longitudinalmente",
  "multiSplit.refused.vertical": "Impossibile dividere: una membratura verticale non ha un asse in pianta che la linea possa attraversare",
  "multiSplit.refused.nearEnd": "Impossibile dividere: la linea attraversa entro {min} cm da un'estremità",
  "multiSplit.done": {
    "one": "Diviso {countDisplay} elemento",
    "other": "Divisi {countDisplay} elementi",
    "many": "Divisi {countDisplay} elementi"
  },
  "multiSplit.leftAlone": {
    "one": "{countDisplay} elemento attraversato dalla linea è rimasto invariato (vedi il motivo accanto)",
    "other": "{countDisplay} elementi attraversati dalla linea sono rimasti invariati (vedi il motivo accanto a ciascuno)",
    "many": "{countDisplay} elementi attraversati dalla linea sono rimasti invariati (vedi il motivo accanto a ciascuno)"
  },
  "multiSplit.openingsSkipped": {
    "one": "{countDisplay} apertura non ha potuto essere riassegnata e potrebbe richiedere un riposizionamento manuale",
    "other": "{countDisplay} aperture non hanno potuto essere riassegnate e potrebbero richiedere un riposizionamento manuale",
    "many": "{countDisplay} aperture non hanno potuto essere riassegnate e potrebbero richiedere un riposizionamento manuale"
  },
  "commandPalette.tool.splitMulti.label": "Dividi lungo una linea"
} satisfies Catalogue;
