/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const stairRailingIt = {
  'stairRailing.tool.stair': 'Scala',
  'stairRailing.tool.railing': 'Ringhiera',
  'stairRailing.stair.label': 'Scala',
  'stairRailing.railing.label': 'Ringhiera',
  'stairRailing.field.riser': 'Alzata',
  'stairRailing.field.tread': 'Pedata',
  'stairRailing.field.waist': 'Soletta',
  'stairRailing.inspector.RiserHeight': 'Altezza dell’alzata',
  'stairRailing.inspector.TreadLength': 'Lunghezza della pedata',
  'stairRailing.inspector.WaistThickness': 'Spessore della soletta',
  'stairRailing.inspector.effect': 'Il piede e il numero di alzate restano fissi. L’altezza dell’alzata modifica il dislivello totale; la lunghezza della pedata modifica lo sviluppo totale.',
  'stairRailing.field.postSpacing': 'Montanti',
  'stairRailing.stair.hintStart': 'Fai clic sul piede della prima alzata · digita una lunghezza per bloccare lo sviluppo',
  'stairRailing.stair.hintEnd': 'Fai clic o premi Invio per posizionare la scala · digita una lunghezza, Tab per angolo, alzata, pedata · Backspace ricomincia · Esc per uscire',
  'stairRailing.stair.tooShort': 'Lo sviluppo è troppo corto: pedate inferiori a 0,1 m non formano una scala. Disegnala più lunga, oppure chiedi un’alzata più alta per avere meno gradini',
  'stairRailing.stair.waistTooThick': 'La soletta è troppo spessa per una rampa con questo dislivello: digitane una più sottile',
  'stairRailing.stair.risers': {
    one: '{countDisplay} alzata · fino a {storey}',
    many: '{countDisplay} alzate · fino a {storey}',
    other: '{countDisplay} alzate · fino a {storey}',
  },
  'stairRailing.stair.risersFree': {
    one: '{countDisplay} alzata · nessun piano superiore',
    many: '{countDisplay} alzate · nessun piano superiore',
    other: '{countDisplay} alzate · nessun piano superiore',
  },
  'stairRailing.railing.hintStart': 'Fai clic per iniziare la ringhiera · si aggancia ai bordi delle solette e ai lati delle scale · digita una lunghezza per bloccarla',
  'stairRailing.railing.hintNext': 'Fai clic per aggiungere un punto · doppio clic o Invio per terminare · Backspace rimuove un punto · Esc ricomincia',
  'stairRailing.railing.needTwo': 'Una ringhiera richiede almeno due punti',
  'stairRailing.railing.summary': {
    one: '{countDisplay} punto · {length}',
    many: '{countDisplay} punti · {length}',
    other: '{countDisplay} punti · {length}',
  },
  'stairRailing.railing.finish': 'Termina',
  'stairRailing.railing.finishTitle': 'Posiziona la ringhiera lungo i punti inseriti finora (Invio)',
  'commandPalette.tool.stair.label': 'Disegna scale',
  'commandPalette.tool.railing.label': 'Disegna ringhiere',
  'commands.model.stair': 'Disegna una scala fino al piano superiore (spazio di lavoro Modello)',
  'commands.model.railing': 'Disegna una ringhiera lungo un percorso (spazio di lavoro Modello)',
} satisfies Catalogue;
