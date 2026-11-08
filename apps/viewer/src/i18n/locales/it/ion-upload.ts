/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const ionUploadIt = {
  "ionUpload.title": "Carica su Cesium ion",
  "ionUpload.description": "Carica un modello IFC con le sue modifiche in sospeso sul tuo account Cesium ion. Sono incluse tutte le proprietà del modello.",
  "ionUpload.close": "Chiudi",
  "ionUpload.upload": "Carica",
  "ionUpload.uploading": "Caricamento…",
  "ionUpload.abort": "Annulla caricamento",
  "ionUpload.successTitle": "Inviato per la suddivisione in tile",
  "ionUpload.errorTitle": "Il caricamento non è stato completato",
  "ionUpload.accepted": "Cesium ion ha accettato il caricamento e lo suddividerà in tile. Apri la risorsa per verificare l'avanzamento e il posizionamento.",
  "ionUpload.cancelled": "Caricamento annullato. Le risorse già create restano in Cesium ion; puoi rimuoverle da lì.",
  "ionUpload.failed": "{phase} operazione non riuscita (HTTP {status}). {help}",
  "ionUpload.failure.authorization": "Il token non può creare risorse. Usa un token con lo scope assets:write (il token predefinito ha solo accesso in lettura) e controlla i suoi URL consentiti in Cesium ion.",
  "ionUpload.failure.conflict": "Cesium ion ha rifiutato la richiesta di caricamento. Se un nuovo tentativo non riesce, segnala questo errore con il suo stato HTTP.",
  "ionUpload.failure.capacity": "Prima di riprovare, controlla in Cesium ion l'abbonamento dell'account, lo spazio di archiviazione disponibile e la dimensione del caricamento.",
  "ionUpload.failure.rateLimit": "Cesium ion sta limitando le richieste. Attendi prima di riprovare.",
  "ionUpload.failure.service": "Cesium ion non ha potuto completare questa richiesta. Controlla lo stato del servizio prima di riprovare.",
  "ionUpload.failure.request": "Prima di riprovare, controlla la connessione e la risorsa in Cesium ion. Il caricamento potrebbe non essere stato completato.",
  "ionUpload.exportWarnings": {
    one: "La preparazione dell'IFC per Cesium ion ha segnalato un problema, quindi non è stato caricato nulla.",
    other: "La preparazione dell'IFC per Cesium ion ha segnalato {count} problemi, quindi non è stato caricato nulla.",
    many: "La preparazione dell'IFC per Cesium ion ha segnalato {count} problemi, quindi non è stato caricato nulla.",
  },
  "ionUpload.serializationFailed": "Impossibile preparare l'IFC modificato. Prova a esportare l'IFC in locale per controllare il modello.",
  "ionUpload.texturesUnsupported": "Questo modello include risorse immagine. Esporta un IFCZIP in locale per conservarne le immagini. Il caricamento diretto delle texture non è ancora supportato.",
  "ionUpload.noModel": "Carica un modello IFC STEP da caricare. IFCX e LandXML non sono supportati.",
  "ionUpload.openAsset": "Visualizza {name} in Cesium ion",
  "ionUpload.model": "Modello",
  "ionUpload.token": "Token Cesium ion (assets:write)",
  "ionUpload.tokenHelp": "Usa un token separato con il permesso assets:write. Viene conservato in memoria finché questa finestra di dialogo non si chiude, e non viene mai salvato né inviato alle statistiche di utilizzo.",
  "ionUpload.createToken": "Crea un token",
  "ionUpload.placement": "Il caricamento conserva la georeferenziazione IFC. I nomi di datum verticale EVRS2007 o EGM2008 riconosciuti vengono caricati come altezza sul livello del mare EGM2008. Il testo degli altri datum viene conservato. Dopo la suddivisione in tile, verifica posizione, orientamento e quota in Cesium ion. Per i modelli senza georeferenziazione, imposta lì la loro posizione.",
  "ionUpload.phase.serialize": "Preparazione dell'IFC modificato…",
  "ionUpload.phase.create": "Creazione della risorsa…",
  "ionUpload.phase.upload": "Caricamento dell'IFC…",
  "ionUpload.phase.complete": "Avvio della suddivisione in tile…",
} satisfies Catalogue;
