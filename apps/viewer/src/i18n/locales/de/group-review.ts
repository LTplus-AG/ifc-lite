/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const groupReviewDe = {
  "groupReview.title": "Überprüfen Sie Gruppenänderungen",
  "groupReview.hint": "Wählen Sie Änderungen und prüfen Sie Gruppennamen und vollständige Mitgliederlisten. Beim Entfernen einer Gruppe bleiben ihre Mitglieder und deren andere Gruppenzugehörigkeiten erhalten.",
  "groupReview.prepare": "Überprüfen Sie ausgewählte Gruppenänderungen",
  "groupReview.acknowledgement": "Ich habe die vollständige Mitgliedschaft und die geteilten Referenzen überprüft.",
  "groupReview.population": "Native Datensätze: {created} erstellt · {modified} geändert · {deleted} gelöscht",
  "groupReview.nativeChanges": "Überprüfen Sie Gruppenänderungen und gemeinsame Referenzen",
  "groupReview.receiptProblem": "Die Änderungen wurden übernommen, ihre Beleg konnte jedoch nicht gespeichert werden. „Rückgängig“ bleibt im Bearbeitungsverlauf verfügbar.",
  "groupReview.op.group.create": "Gruppe erstellen",
  "groupReview.op.group.update": "Gruppe aktualisieren und komplette Mitgliedschaft ersetzen",
  "groupReview.op.group.remove": "Gruppe entfernen",
} satisfies Catalogue;
