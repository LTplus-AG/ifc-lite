/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackChecksDe = {
  "assistantSources.duplicates.title": "Doppelte Bauteile",
  "assistantSources.duplicates.description": "Beim Duplikatscan gefundene Sätze übereinstimmender oder überlappender Kopien.",
  "assistantSources.duplicates.rows": "Jede Zeile ist eine Gruppe deckungsgleicher Bauteile, kein einzelnes Paar.",
  "assistantSources.duplicates.unavailable": "Bei der Erfassung lag kein Duplikatsuchergebnis vor. Führen Sie „Duplikate suchen“ in der Kollisionserkennung aus und aktualisieren Sie die Belege.",
  "assistantSources.duplicates.suggestSummary": "Fassen Sie die Duplikatgruppen und die betroffenen Bauteiltypen zusammen",
  "assistantSources.duplicates.suggestCleanup": "Welche Duplikatgruppen wirken wie exakte Kopien, die zuerst entfernt werden sollten?",
  "assistantSources.duplicates.pickSets": {"one": "{count} Duplikatsatz", "other": "{count} Duplikatsätze"},
  "assistantSources.manualChecklist.title": "Manuelle Checkliste",
  "assistantSources.manualChecklist.description": "Die geöffnete manuelle Checkliste und die Bewertungen, die Prüfer für jedes geladene Modell erfasst haben.",
  "assistantSources.manualChecklist.rows": "Jede Zeile ist ein Checklistenpunkt für ein Modell, mit der Bewertung des Prüfers oder noch ohne Bewertung.",
  "assistantSources.manualChecklist.unavailable": "Bei der Erfassung war keine manuelle Checkliste geöffnet. Öffnen oder erstellen Sie eine in der Datenvalidierung und aktualisieren Sie die Belege.",
  "assistantSources.manualChecklist.suggestSummary": "Fassen Sie den Fortschritt der Checkliste und die fehlgeschlagenen Punkte zusammen",
  "assistantSources.manualChecklist.suggestOpen": "Welche Fragen sind noch unbeantwortet und was sollte als nächstes überprüft werden?",
  "assistantSources.manualChecklist.pickItems": {"one": "{count} Eintrag", "other": "{count} Einträge"},
  "assistantSources.manualChecklist.pickNone": "Keine Checkliste geöffnet",
  "assistantSources.lens.description": "Anzahl der Bauteile, auf die jede Regel der aktiven Linse zutrifft, mit Beispielen.",
  "assistantSources.lens.rows": "Jede Zeile ist eine Linsenregel oder ein Farbzuordnungswert mit der zugehörigen Trefferzahl.",
  "assistantSources.lens.unavailable": "Bei der Erfassung war keine ausgewertete Linse aktiv. Aktivieren Sie eine Linse und aktualisieren Sie die Belege.",
  "assistantSources.lens.suggestSummary": "Erklären Sie, was die aktive Linse zeigt und welche Regeln auf die meisten Bauteile zutreffen",
  "assistantSources.lens.pickRules": {"one": "{name} · {count} Regel", "other": "{name} · {count} Regeln"},
  "assistantSources.lens.pickNone": "Keine Linse aktiv",
  "assistantSources.lens.pickPending": "Wird ausgewertet…",
  "assistantSources.bcf.description": "Themen des geladenen BCF-Projekts: Status, Priorität, Zuordnung und referenzierte Bauteile.",
  "assistantSources.bcf.rows": "Jede Zeile ist ein BCF-Thema. Kommentartexte und Momentaufnahmen sind nicht enthalten.",
  "assistantSources.bcf.unavailable": "Bei der Erfassung wurde kein BCF-Projekt geladen. Öffnen oder erstellen Sie BCF-Themen und aktualisieren Sie die Belege.",
  "assistantSources.bcf.suggestSummary": "Fassen Sie die offenen Themen nach Status und Priorität zusammen",
  "assistantSources.bcf.suggestPriorities": "Welche Themen sollten zuerst gelöst werden und wem werden sie zugewiesen?",
  "assistantSources.bcf.pickTopics": {"one": "{count} Thema", "other": "{count} Themen"},
  "assistantSources.bcf.pickNone": "Kein BCF-Projekt",
} satisfies Catalogue;
