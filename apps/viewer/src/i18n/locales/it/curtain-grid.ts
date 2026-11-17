/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const curtainGridIt = {
  "curtainWall.label": "Facciata continua",
  "curtainWall.palette": "Posiziona facciate continue",
  "commands.model.curtainWall": "Posiziona facciate continue: montanti, traversi e pannelli (spazio Modello)",
  "curtainWall.hint.start": "Fai clic per iniziare la facciata continua · digita una lunghezza per bloccarla",
  "curtainWall.hint.end": "Fai clic o premi Invio per posizionarla · la griglia mostra i suoi pannelli · Esc ricomincia",
  "curtainWall.field.baseOffset": "Base",
  "curtainWall.field.panelWidth": "Larghezza pannello",
  "curtainWall.field.panelHeight": "Altezza pannello",
  "curtainWall.field.mullionWidth": "Larghezza montante",
  "curtainWall.field.mullionDepth": "Profondità montante",
  "curtainWall.tooShort": "La facciata continua è troppo corta: fai clic più lontano dall'inizio",
  "curtainWall.noOpening": "Montanti e traversi non lasciano alcuna apertura libera: allarga i pannelli o assottiglia il montante",
  "curtainWall.tooManyPanels": "Questa dimensione genera troppi pannelli: aumentala",
  "curtainWall.summary": "{bays} × {rows} pannelli",
  "grid.label": "Griglia",
  "grid.palette": "Posiziona griglie",
  "commands.model.grid": "Posiziona una griglia di progetto con assi etichettati (spazio Modello)",
  "grid.hint.corner": "Fai clic sul primo angolo della griglia · digita una larghezza per bloccarla",
  "grid.hint.opposite": "Fai clic sull'angolo opposto o premi Invio · Shift la rende quadrata · Esc ricomincia",
  "grid.field.spacingU": "Spaziatura U",
  "grid.field.spacingV": "Spaziatura V",
  "grid.tags.label": "Etichettatura degli assi",
  "grid.tags.numbers": "1, 2, 3",
  "grid.tags.letters": "A, B, C",
  "grid.noArea": "La griglia non ha area: fai clic su un angolo lontano dal primo",
  "grid.tooManyAxes": "Questa spaziatura genera troppi assi: aumentala",
  "grid.summary": "{uAxes} × {vAxes} assi"
} satisfies Catalogue;
