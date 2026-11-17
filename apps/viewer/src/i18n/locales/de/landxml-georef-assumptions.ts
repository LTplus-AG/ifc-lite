/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const landxmlGeorefAssumptionsDe = {
  "landXmlGeorefAssumptions.sharedVerticalDatum.label": "Gemeinsames Höhensystem annehmen",
  "landXmlGeorefAssumptions.sharedVerticalDatum.description": "Wenn die LandXML-Datei oder das Modell, auf dem sie platziert wird, kein Höhensystem angibt, werden die Höhen unverändert platziert, als nutzten beide dasselbe System. Ist das nicht der Fall, liegt die Oberfläche um die Differenz der beiden Höhensysteme zu hoch oder zu tief.",
  "landXmlGeorefAssumptions.epsgFromName.label": "EPSG-Code aus dem Namen des Koordinatensystems lesen",
  "landXmlGeorefAssumptions.epsgFromName.description": "Wenn LandXML CoordinateSystem keinen EPSG-Code angibt, sein Name aber genau „EPSG:“ gefolgt von einer Zahl ist (z. B. EPSG:31467), wird dieser Code verwendet. Andere Namen werden nie ausgewertet. War der Name nur eine Bezeichnung, landet die Oberfläche an der falschen Stelle.",
  "landXmlGeorefAssumptions.title": "LandXML-Datei „{fileName}“ konnte nicht am Modell ausgerichtet werden",
  "landXmlGeorefAssumptions.offer": "Sie kann platziert werden, wenn Sie Folgendes akzeptieren:",
  "landXmlGeorefAssumptions.load": "Mit diesen Annahmen laden",
  "landXmlGeorefAssumptions.always": "Dies immer annehmen",
  "landXmlGeorefAssumptions.alwaysHint": "„Dies immer annehmen“ aktiviert die ausgewählten Annahmen auch unter Einstellungen, Allgemein für jede spätere LandXML-Datei. Dort können Sie sie wieder deaktivieren.",
  "landXmlGeorefAssumptions.cancel": "Abbrechen",
  "landXmlGeorefAssumptions.settings": "LandXML-Georeferenzierung",
  "landXmlGeorefAssumptions.settingsHint": "Beide Optionen sind standardmäßig aus: Eine LandXML-Datei ohne Angaben zur Ausrichtung am Modell wird abgelehnt; die Meldung nennt fehlende Angaben. Aktivieren Sie eine Option nur, wenn sie für Ihre Dateien zutrifft. So platzierte Modelle werden als „Angenommen“ markiert.",
  "landXmlGeorefAssumptions.badge": "Angenommen",
  "landXmlGeorefAssumptions.assumed": "Mit den von Ihnen gewählten Annahmen platziert",
  "landXmlGeorefAssumptions.sharedVerticalDatum.applied": "Für die Höhen wurde das Höhensystem des Ankermodells angenommen: Kein vertikaler Bezug angegeben.",
  "landXmlGeorefAssumptions.epsgFromName.applied": "{crs} aus dem CoordinateSystem-Namen gelesen: Kein EPSG-Code angegeben."
} satisfies Catalogue;
