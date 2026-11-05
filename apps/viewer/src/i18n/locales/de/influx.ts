/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const influxDe = {
  "influx.title": "InfluxDB 2",
  "influx.experimental": "Experimentell",
  "influx.help": "Schreibgeschützte synthetische oder aktuelle Telemetrie, zugeordnet über IFC GlobalId. Wählen Sie im Modell einen IfcSpace oder IfcSensor aus.",
  "influx.bounds": "Lädt die letzte Stunde mit bis zu 10.000 Messwerten. Überschreitung oder ungültige Daten lassen den gesamten Ladevorgang scheitern. Anzeigeeinheiten sind Beschriftungen, keine Umrechnungen.",
  "influx.url": "InfluxDB-URL",
  "influx.org": "Organisation",
  "influx.bucket": "Bucket",
  "influx.measurement": "Messreihe (Measurement)",
  "influx.field": "Numerisches Feld",
  "influx.guidTag": "GUID-Tag-Schlüssel",
  "influx.unit": "Anzeigeeinheit",
  "influx.token": "Token (nur im Arbeitsspeicher)",
  "influx.load": "Laden",
  "influx.loading": "Wird geladen…",
  "influx.loaded": "{samples} Messwerte geladen.",
  "influx.select": "Wählen Sie einen eindeutig zugeordneten IfcSpace oder IfcSensor, um seinen Messwert zu sehen.",
  "influx.latest": "Zuletzt: {value} {unit}",
  "influx.history": "Verlauf für {name}: {samples} Messwerte",
  "influx.timestamp": "Letzter Messwert: {time}",
  "influx.unmatched": "Nicht zugeordnete Reihen ({count})",
  "influx.ambiguous": "Mehrdeutige Reihen ({count}) — keine Zuordnung vorgenommen",
  "influx.none": "Keine",
  "influx.error.config": "Prüfen Sie alle Verbindungsfelder. Verwenden Sie HTTPS oder zur Entwicklung http://localhost. Zugangsdaten, Abfrageparameter und Fragmente sind in der URL nicht erlaubt.",
  "influx.error.network": "CORS- oder Netzwerkfehler. Der InfluxDB-Server muss die Herkunft dieses Viewers zulassen; alternativ können Sie ein Gateway mit festem Zielserver betreiben.",
  "influx.error.http": "InfluxDB hat die Abfrage abgelehnt. Prüfen Sie Organisation, Bucket und Leseberechtigungen des Tokens.",
  "influx.error.data": "Laden fehlgeschlagen: fehlerhafte, gekürzte, zu große, nicht numerische oder widersprüchliche Daten, eine Fehlertabelle oder mehr als 10.000 Messwerte. Grenzen Sie die Quelldaten vor einem erneuten Versuch ein.",
  "influx.error.storage": "Konfiguration konnte nicht gespeichert werden. Prüfen Sie den Zugriff auf den Browserspeicher."
} satisfies Catalogue;
