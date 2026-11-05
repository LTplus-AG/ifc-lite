/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const ionUploadDe = {
  "ionUpload.title": "Zu Cesium ion hochladen",
  "ionUpload.description": "Ein IFC-Modell mit seinen ausstehenden Änderungen in Ihr Cesium-ion-Konto hochladen. Alle Modelleigenschaften werden eingeschlossen.",
  "ionUpload.close": "Schließen",
  "ionUpload.upload": "Hochladen",
  "ionUpload.uploading": "Wird hochgeladen…",
  "ionUpload.abort": "Hochladen abbrechen",
  "ionUpload.successTitle": "Zur Kachelerstellung eingereicht",
  "ionUpload.errorTitle": "Hochladen nicht abgeschlossen",
  "ionUpload.accepted": "Cesium ion hat den Upload angenommen und erstellt Kacheln. Öffnen Sie das Asset, um Fortschritt und Platzierung zu prüfen.",
  "ionUpload.cancelled": "Hochladen abgebrochen. Bereits erstellte Assets bleiben in Cesium ion erhalten; Sie können sie dort entfernen.",
  "ionUpload.failed": "{phase} fehlgeschlagen (HTTP {status}). {help}",
  "ionUpload.failure.authorization": "Das Token kann keine Assets erstellen. Verwenden Sie ein Token mit dem Berechtigungsumfang assets:write (das Standardtoken erlaubt nur Lesen) und prüfen Sie seine erlaubten URLs in Cesium ion.",
  "ionUpload.failure.conflict": "Cesium ion hat die Upload-Anfrage abgelehnt. Falls ein erneuter Versuch fehlschlägt, melden Sie diesen Fehler mit seinem HTTP-Status.",
  "ionUpload.failure.capacity": "Prüfen Sie vor einem erneuten Versuch Kontotarif, Speicherlimit und Upload-Größe in Cesium ion.",
  "ionUpload.failure.rateLimit": "Cesium ion begrenzt die Anfragen. Warten Sie vor einem erneuten Versuch.",
  "ionUpload.failure.service": "Cesium ion konnte diese Anfrage nicht abschließen. Prüfen Sie vor einem erneuten Versuch den Dienststatus.",
  "ionUpload.failure.request": "Prüfen Sie vor einem erneuten Versuch die Verbindung und das Asset in Cesium ion. Der Upload wurde möglicherweise nicht abgeschlossen.",
  "ionUpload.exportWarnings": {
    "one": "Bei der IFC-Vorbereitung für Cesium ion wurde ein Problem gemeldet; es wurde nichts hochgeladen.",
    "other": "Bei der IFC-Vorbereitung für Cesium ion wurden {count} Probleme gemeldet; es wurde nichts hochgeladen."
  },
  "ionUpload.serializationFailed": "Die bearbeitete IFC konnte nicht vorbereitet werden. Exportieren Sie IFC versuchsweise lokal, um das Modell zu prüfen.",
  "ionUpload.texturesUnsupported": "Dieses Modell enthält Bildressourcen. Exportieren Sie IFCZIP lokal, um die Bilder zu erhalten. Direktes Hochladen von Texturen wird noch nicht unterstützt.",
  "ionUpload.noModel": "Laden Sie ein STEP-IFC-Modell zum Hochladen. IFCX und LandXML werden nicht unterstützt.",
  "ionUpload.openAsset": "{name} in Cesium ion ansehen",
  "ionUpload.model": "Modell",
  "ionUpload.token": "Cesium-ion-Token (assets:write)",
  "ionUpload.tokenHelp": "Verwenden Sie ein eigenes Token mit assets:write-Berechtigung. Es bleibt bis zum Schließen dieses Dialogs im Arbeitsspeicher und wird nie gespeichert oder an Analysedienste gesendet.",
  "ionUpload.createToken": "Token erstellen",
  "ionUpload.placement": "Der Upload erhält Ihre IFC-Georeferenzierung. Erkannte vertikale Bezugsnamen EVRS2007 oder EGM2008 werden als EGM2008-Höhe über dem Meeresspiegel hochgeladen. Andere Bezugstexte bleiben erhalten. Prüfen Sie nach der Kachelerstellung Standort, Ausrichtung und Höhe in Cesium ion. Legen Sie dort bei Modellen ohne Georeferenzierung den Standort fest.",
  "ionUpload.phase.serialize": "Bearbeitete IFC wird vorbereitet…",
  "ionUpload.phase.create": "Asset wird erstellt…",
  "ionUpload.phase.upload": "IFC wird hochgeladen…",
  "ionUpload.phase.complete": "Kachelerstellung wird gestartet…"
} satisfies Catalogue;
