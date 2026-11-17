/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const flowReviewDe = {
  "flowReview.title": "KI-Vorschlag prüfen",
  "flowReview.paused": {
    "one": "Der Lauf wurde bei {nodes} angehalten. Nachfolgende Knoten laufen erst, wenn Sie diesen Vorschlag genehmigen.",
    "other": "Der Lauf wurde bei {nodes} angehalten. Nachfolgende Knoten laufen erst, wenn Sie diesen Vorschlag genehmigen."
  },
  "flowReview.node": "{node} ({type})",
  "flowReview.digest": "Vorschlag {digest}",
  "flowReview.created": "Zur Prüfung gespeichert {time}",
  "flowReview.coverage.classify": "{rows} Zeilen · {classified} klassifiziert · {unknown} unbekannt · {failed} fehlgeschlagen · {notSent} nicht gesendet · {requests} Anfragen · Modell {model}",
  "flowReview.coverage.summarize": "{rows} Zeilen · {sent} gesendet · {sections} Abschnitte · {uncited} ohne Beleg · {requests} Anfragen · Modell {model}",
  "flowReview.coverage.extract": "{passages} Passagen · {sent} gesendet · {records} Datensätze · {unsupported} unbelegt · {requests} Anfragen · Modell {model}",
  "flowReview.approve": "Genehmigen und fortsetzen",
  "flowReview.resume": "Fortsetzen",
  "flowReview.reject": "Ablehnen",
  "flowReview.dismiss": "Schließen",
  "flowReview.state.prepared": "Nachfolgende Knoten wurden noch nicht ausgeführt. Genehmigen Sie genau diesen Vorschlag zum Fortsetzen oder lehnen Sie ihn ab.",
  "flowReview.state.reviewed": "Genehmigt. Beim Fortsetzen wird der restliche Graph auf Basis genau dieses Vorschlags ausgeführt.",
  "flowReview.state.applying": "Fortsetzen mit genehmigtem Vorschlag…",
  "flowReview.state.completed": "Mit genehmigtem Vorschlag fortgesetzt. Vor der Pause abgeschlossene Knoten wurden wiederhergestellt und nicht erneut ausgeführt. Für diesen Vorschlag wurde keine neue KI-Anfrage gesendet.",
  "flowReview.state.partial": "Die Fortsetzung wurde nicht abgeschlossen ({reason}). Nachfolgende Auswirkungen können unvollständig sein; dieser Vorschlag kann nicht erneut fortgesetzt werden. Führen Sie den Graphen für eine neue Prüfung erneut aus.",
  "flowReview.state.rejected": "Abgelehnt. Keine dem Vorschlag nachfolgenden Knoten wurden ausgeführt.",
  "flowReview.refused.graph-changed": "Der Graph oder seine Ausführungseingaben wurden nach Erstellung dieses Vorschlags geändert. Führen Sie den Graphen für eine neue Prüfung erneut aus.",
  "flowReview.refused.sources-changed": "Die Modelle oder ihre Bearbeitungen wurden nach Erstellung dieses Vorschlags geändert. Führen Sie den Graphen für eine neue Prüfung erneut aus.",
  "flowReview.refused.other": "Dieser Vorschlag kann nicht fortgesetzt werden: {reason}",
  "flowReview.notSaved": "Der Vorschlag konnte nicht zur Prüfung gespeichert werden, daher wurden keine nachfolgenden Knoten ausgeführt: {reason}",
  "flowReview.needsModel": "KI-Knoten verwenden das für den Assistenten gewählte Modell. Wählen Sie ein Modell oder hinterlegen Sie einen Schlüssel dafür, um diesen Graphen auszuführen."
} satisfies Catalogue;
