/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const pushPullAlignIt = {
  "commands.model.pushPull": "Spingi o tira una faccia dell'elemento selezionato (area di lavoro Modello)",
  "commands.model.align": "Allinea gli elementi a un bordo di un riferimento (area di lavoro Modello)",
  "modelWorkspace.tool.pushPull": "Spingi / Tira",
  "modelWorkspace.tool.align": "Allinea",
  "modelWorkspace.blocked.pushPull": "Seleziona un muro, una soletta, un pilastro o una trave da spingere o tirare",
  "commandPalette.tool.pushPull.label": "Spingi / Tira una faccia",
  "commandPalette.tool.align.label": "Allinea elementi",
  "pushPull.label": "Spingi / Tira",
  "pushPull.field.size": "Dimensione",
  "pushPull.hint.noTarget": "Seleziona un muro, una soletta, un pilastro o una trave per spingerne o tirarne le facce.",
  "pushPull.hint.pick": "Afferra una maniglia di faccia, poi trascina o digita una dimensione",
  "pushPull.hint.drag": "Trascina o digita la dimensione · clic o Invio applica · Esc annulla",
  "pushPull.unchanged": "La dimensione non è cambiata.",
  "pushPull.face.wallHeight": "Altezza del muro",
  "pushPull.face.wallThickness": "Spessore del muro",
  "pushPull.face.slabThickness": "Spessore della soletta",
  "pushPull.face.length": "Lunghezza",
  "pushPull.handleAria": "Tira: {face}",
  "pushPull.bar.readout": "{face} {delta} m",
  "pushPull.bar.snapLevel": "Agganciato a una quota di piano",
  "pushPull.bar.snapStep": "Agganciato a un passo",
  "align.label": "Allinea",
  "align.hint.reference": "Fai clic sull'elemento a cui allineare gli altri",
  "align.hint.targets": "Fai clic sugli elementi da allineare a esso",
  "align.hint.commit": "Invio li allinea · fai clic su un elemento per aggiungerlo o toglierlo · Esc ricomincia",
  "align.alreadyAligned": "Sono già allineati su questo bordo.",
  "align.mode.aria": "Bordo su cui allineare",
  "align.mode.left": "Sinistra",
  "align.mode.centre": "Centro",
  "align.mode.right": "Destra",
  "align.mode.top": "Alto",
  "align.mode.middle": "Mezzo",
  "align.mode.bottom": "Basso",
  "align.bar.count": "{targets} scelti · {moving} da spostare",
} satisfies Catalogue;
