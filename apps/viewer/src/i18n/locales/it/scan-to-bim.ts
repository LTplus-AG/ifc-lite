/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const scanToBimIt = {
  "scanToBim.title": "Dalla scansione al BIM",
  "scanToBim.intro": "Rileva muri, solai, colonne e tubi nella scansione e revisionali come elementi IFC proposti.",
  "scanToBim.scanLabel": "Scansione",
  "scanToBim.target": "Proposte per {model} ({schema})",
  "scanToBim.noTarget": "Nessun modello IFC caricato: la classe dei tubi usa IFC4 come predefinito.",
  "scanToBim.cropped": "Vengono usati solo i punti nel riquadro di sezione.",
  "scanToBim.whole": "Viene usato l'intero campione conservato della scansione. Attiva un riquadro di sezione per rilevare una regione.",
  "scanToBim.detect": "Rileva elementi",
  "scanToBim.detectAgain": "Rileva di nuovo",
  "scanToBim.cancel": "Annulla",
  "scanToBim.stage.starting": "Avvio del rilevamento…",
  "scanToBim.stage.segmenting": "Ricerca di piani e cilindri…",
  "scanToBim.stage.proposing": "Proposta di elementi…",
  "scanToBim.error.noSample": "Questa scansione non ha ancora punti conservati su cui eseguire il rilevamento.",
  "scanToBim.error.failed": "Rilevamento non riuscito: {message}",
  "scanToBim.summary": {
    "one": "{count} proposta da {planes} piani e {cylinders} cilindri ({points} punti)",
    "other": "{count} proposte da {planes} piani e {cylinders} cilindri ({points} punti)",
    "many": "{count} proposte da {planes} piani e {cylinders} cilindri ({points} punti)"
  },
  "scanToBim.summaryCropped": "Ritaglio del riquadro di sezione.",
  "scanToBim.decided": "{accepted} accettate, {rejected} rifiutate, {pending} da revisionare",
  "scanToBim.filter.legend": "Mostra",
  "scanToBim.filter.class": "{label} ({count})",
  "scanToBim.filter.minConfidence": "Affidabilità minima",
  "scanToBim.filter.minConfidenceValue": "{value} %",
  "scanToBim.acceptShown": "Accetta tutte le visualizzate",
  "scanToBim.rejectShown": "Rifiuta tutte le visualizzate",
  "scanToBim.resetShown": "Ripristina visualizzate",
  "scanToBim.listLabel": "Elementi proposti",
  "scanToBim.empty": "Nessuna proposta corrisponde al filtro.",
  "scanToBim.accept": "Accetta",
  "scanToBim.reject": "Rifiuta",
  "scanToBim.acceptOne": "Accetta {id}",
  "scanToBim.rejectOne": "Rifiuta {id}",
  "scanToBim.confidence": "{value} %",
  "scanToBim.class.IfcWall": "Muri",
  "scanToBim.class.IfcSlab": "Solai",
  "scanToBim.class.IfcColumn": "Colonne",
  "scanToBim.class.IfcPipeSegment": "Tubi",
  "scanToBim.class.IfcFlowSegment": "Tubi (segmenti di flusso)",
  "scanToBim.basis.pairedFaces": "due facce, spessore misurato",
  "scanToBim.basis.singleFace": "una faccia, spessore predefinito",
  "scanToBim.basis.floorCeilingPair": "pavimento e soffitto, spessore misurato",
  "scanToBim.basis.floor": "pavimento, spessore predefinito",
  "scanToBim.basis.ceiling": "soffitto, spessore predefinito",
  "scanToBim.basis.cylinder": "adattamento a cilindro",
  "scanToBim.size.wall": "{length} m di lunghezza, {thickness} m di spessore, {height} m di altezza",
  "scanToBim.size.slab": "{area} m², {thickness} m di spessore",
  "scanToBim.size.column": "Ø {diameter} m, {height} m di altezza",
  "scanToBim.size.pipe": "Ø {diameter} m, {length} m di lunghezza",
  "scanToBim.create": "Crea elementi accettati",
  "scanToBim.createCount": {
    "one": "Crea {count} elemento accettato in {model}",
    "other": "Crea {count} elementi accettati in {model}",
    "many": "Crea {count} elementi accettati in {model}"
  },
  "scanToBim.createNone": "Accetta proposte per crearle come elementi IFC.",
  "scanToBim.acceptedHidden": {
    "one": "{count} proposta accettata è nascosta dal filtro e non verrà creata.",
    "other": "{count} proposte accettate sono nascoste dal filtro e non verranno create.",
    "many": "{count} proposte accettate sono nascoste dal filtro e non verranno create."
  },
  "scanToBim.createdEarlier": {
    "one": "{count} elemento creato da {scan} prima in questa sessione è in {model}; crearlo di nuovo potrebbe duplicarlo.",
    "other": "{count} elementi creati da {scan} prima in questa sessione sono in {model}; crearli di nuovo potrebbe duplicarli.",
    "many": "{count} elementi creati da {scan} prima in questa sessione sono in {model}; crearli di nuovo potrebbe duplicarli."
  },
  "scanToBim.needsModel": "Per creare elementi serve un modello IFC che li contenga.",
  "scanToBim.createBlank": "Crea un modello IFC vuoto",
  "scanToBim.creatingBlank": "Creazione di un modello IFC vuoto…",
  "scanToBim.blankFailed": "Impossibile creare il modello IFC vuoto.",
  "scanToBim.created": {
    "one": "{count} elemento creato in {model}, un passaggio annullabile.",
    "other": "{count} elementi creati in {model}, un passaggio annullabile.",
    "many": "{count} elementi creati in {model}, un passaggio annullabile."
  },
  "scanToBim.createFailed": "Impossibile creare gli elementi: {message}",
  "scanToBim.frameMoved": "La scansione si è spostata dopo il rilevamento, quindi le proposte non coincidono più con essa. Rileva di nuovo, poi crea.",
  "scanToBim.createdBadge": "Creato",
  "scanToBim.fit": "RMS {rms} mm, {points} punti"
} satisfies Catalogue;
