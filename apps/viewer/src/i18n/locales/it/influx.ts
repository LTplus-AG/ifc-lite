/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const influxIt = {
  "influx.title": "InfluxDB 2",
  "influx.experimental": "Sperimentale",
  "influx.help": "Telemetria sintetica o in tempo reale in sola lettura, abbinata tramite GlobalId IFC. Seleziona un IfcSpace o un IfcSensor nel modello.",
  "influx.bounds": "Carica l'ultima ora, fino a 10.000 campioni. Un superamento del limite o dati non validi fanno fallire l'intero caricamento. Le unità di visualizzazione sono etichette, non conversioni.",
  "influx.url": "URL di InfluxDB",
  "influx.org": "Organizzazione",
  "influx.bucket": "Bucket",
  "influx.measurement": "Measurement",
  "influx.field": "Campo numerico",
  "influx.guidTag": "Chiave del tag GUID",
  "influx.unit": "Unità di visualizzazione",
  "influx.token": "Token (solo in memoria)",
  "influx.load": "Carica",
  "influx.loading": "Caricamento…",
  "influx.loaded": "Caricati {samples} campioni.",
  "influx.select": "Seleziona un IfcSpace o un IfcSensor con abbinamento univoco per vederne la lettura.",
  "influx.latest": "Ultimo: {value} {unit}",
  "influx.history": "Cronologia di {name}: {samples} campioni",
  "influx.timestamp": "Ultimo campione: {time}",
  "influx.unmatched": "Serie senza corrispondenza ({count})",
  "influx.ambiguous": "Serie ambigue ({count}): nessuna assegnazione effettuata",
  "influx.none": "Nessuna",
  "influx.error.config": "Controlla tutti i campi di connessione. Usa HTTPS, oppure http://localhost per lo sviluppo. Credenziali, stringhe di query e frammenti non sono ammessi nell'URL.",
  "influx.error.network": "Errore CORS o di rete. Il server InfluxDB deve consentire l'origine di questo visualizzatore, oppure puoi usare un gateway con upstream fisso.",
  "influx.error.http": "InfluxDB ha rifiutato la query. Controlla l'organizzazione, il bucket e i permessi di lettura del token.",
  "influx.error.data": "Caricamento non riuscito: dati malformati, troncati, troppo grandi, non numerici o in conflitto, una tabella di errore oppure più di 10.000 campioni. Restringi i dati di origine prima di riprovare.",
  "influx.error.storage": "Impossibile salvare la configurazione. Controlla l'accesso all'archiviazione del browser.",
} satisfies Catalogue;
