/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const roomToolIt = {
  "roomTool.options.minArea": "Area minima (m²)",
  "roomTool.options.namePattern": "Schema del nome",
  "roomTool.options.nameHint": "Il token {token} inserisce il numero del locale.",
  "roomTool.options.classification": "IfcSpace.{attribute}",
  "roomTool.options.objectType": "IfcSpace.ObjectType",
  "roomTool.options.invalid": "Inserisci un'area minima positiva e uno schema del nome del locale non vuoto",
  "roomTool.options.objectTypeRequired": "Inserisci IfcSpace.ObjectType per un locale USERDEFINED",
  "roomTool.preview.total": {
    one: "{countDisplay} nuovo locale · {area} m² in totale",
    other: "{countDisplay} nuovi locali · {area} m² in totale",
    many: "{countDisplay} nuovi locali · {area} m² in totale",
  },
  "roomTool.preview.graph": "{walls} muri · {vertices} vertici del layout · {edges} spigoli del layout",
  "roomTool.preview.leaks": "{openEnds} estremità di muro aperte · {unboundedWalls} muri non racchiudono alcun locale",
  "roomTool.label": "Locale",
  "commands.model.room": "Crea locali dai muri o disegnali (area di lavoro Modello)",
  "roomTool.hint.pick": "Fai clic all'interno dei muri per creare un locale · Auto crea tutti i locali di questo piano",
  "roomTool.hint.taken": "Quest'area ha già un locale",
  "roomTool.hint.drawCorner": "Fai clic sugli angoli del locale",
  "roomTool.hint.drawClose": "Invio, un doppio clic o un clic sul primo angolo chiude il locale",
  "roomTool.mode.label": "Come creare un locale",
  "roomTool.mode.pick": "Scegli",
  "roomTool.mode.draw": "Disegna",
  "roomTool.boundary.label": "Quale faccia del muro segue il locale",
  "roomTool.boundary.inner": "Interna",
  "roomTool.boundary.center": "Asse",
  "roomTool.boundary.outer": "Esterna",
  "roomTool.auto.label": "Auto · {countDisplay}",
  "roomTool.auto.title": "Trasforma in locale ogni area di questo piano racchiusa da muri che non ha ancora un locale, in un unico passaggio annullabile",
  "roomTool.auto.none": "Ogni area di questo piano racchiusa da muri ha già un locale",
  "roomTool.update.label": "Aggiorna locali",
  "roomTool.update.title": "Ricalcola i contorni dei locali selezionati dai muri nel loro stato attuale",
  "roomTool.update.noSelection": "Seleziona prima i locali da aggiornare",
  "roomTool.update.none": "Nessuno dei locali selezionati ha potuto essere aggiornato: ciascuno deve essere un'estrusione in pianta su un piano, all'interno di muri",
  "roomTool.update.skipped": {
    one: "{countDisplay} locale selezionato è stato lasciato com'era: non è un'estrusione in pianta su un piano, oppure nessun muro lo racchiude",
    other: "{countDisplay} locali selezionati sono stati lasciati com'erano: non sono estrusioni in pianta su un piano, oppure nessun muro li racchiude",
    many: "{countDisplay} locali selezionati sono stati lasciati com'erano: non sono estrusioni in pianta su un piano, oppure nessun muro li racchiude",
  },
  "roomTool.wasmFailed": "Il motore dei locali non è stato caricato, quindi non è possibile ricavare i locali: ricarica la pagina e riprova",
  "roomTool.palette": "Crea locali",
  "roomTool.loading": "Lettura dei muri… riprova tra un momento",
  "roomTool.noWalls": "Nessun muro di questo piano racchiude un locale: disegna i muri oppure passa a Disegna",
  "roomTool.pick.none": "Nessun muro racchiude questo punto: fai clic all'interno di un locale oppure passa a Disegna",
  "roomTool.pick.taken": "Quest'area ha già un locale",
  "roomTool.draw.needThree": "Un locale richiede almeno tre angoli",
} satisfies Catalogue;
