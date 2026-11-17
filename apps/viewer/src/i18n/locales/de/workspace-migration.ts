/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const workspaceMigrationDe = {
  'workspaceMigration.layout.title': 'Aktualisiertes Layout prüfen',
  'workspaceMigration.layout.summary': 'Layoutänderungen zur Prüfung: {count}. Ihre gespeicherte Arbeit bleibt erhalten.',
  'workspaceMigration.layout.showChanges': 'Änderungen anzeigen',
  'workspaceMigration.layout.hideChanges': 'Änderungen ausblenden',
  'workspaceMigration.layout.keep': 'Layout behalten',
  'workspaceMigration.layout.reset': 'Layout zurücksetzen',
  'workspaceMigration.layout.added': '{panel} nach {anchor} hinzugefügt.',
  'workspaceMigration.layout.addedTop': '{panel} zur Bereichsliste hinzugefügt.',
  'workspaceMigration.layout.renamed': '{from} in {panel} umbenannt.',
  'workspaceMigration.layout.restored': '{panel} in der Bereichsliste wiederhergestellt.',
  'workspaceMigration.layout.preserved': 'Die nicht verfügbare Platzierung {id} wurde für später beibehalten.',
  'workspaceMigration.layout.regrouped': 'Bereichsgruppen aktualisiert.',
  'workspaceMigration.layout.mode': 'Seitenleistenmodus aktualisiert.',
  'workspaceMigration.layout.unreadable': 'Das gespeicherte Layout konnte nicht gelesen werden. Das Original bleibt zur Wiederherstellung erhalten.',
  'workspaceMigration.placement.title': 'Nicht verfügbare Erweiterungsplatzierungen',
  'workspaceMigration.placement.notRendered': 'Der Viewer hat keine Oberfläche für {slot}. Die Platzierung bleibt erhalten.',
  'workspaceMigration.placement.hostOwned': 'Der Viewer verwaltet {slot}; Erweiterungen können diese Oberfläche nicht ersetzen.',
  'workspaceMigration.placement.unknownSlot': 'Der Slot {slot} ist unbekannt. Die Platzierung bleibt erhalten.',
  'workspaceMigration.deepLink.copy': 'Link kopieren',
  'workspaceMigration.deepLink.copyNamed': 'Link zu {name} kopieren',
  'workspaceMigration.deepLink.copied': 'Link kopiert',
  'workspaceMigration.deepLink.copyFailed': 'Der Link konnte nicht kopiert werden.',
  'workspaceMigration.deepLink.failed': 'Das verlinkte Element konnte nicht geöffnet werden.',
  'workspaceMigration.deepLink.busy': 'Warten Sie, bis die aktuelle Anfrage abgeschlossen ist, und öffnen Sie den Link dann erneut.',
  'workspaceMigration.deepLink.unavailable': 'Das verlinkte Element ist in diesem Browser nicht verfügbar.',
  'workspaceMigration.deepLink.missingConversation': 'Diese gespeicherte Unterhaltung wurde in diesem Browser nicht gefunden.',
  'workspaceMigration.deepLink.missingReceipt': 'Dieser Anfragebeleg wurde in dieser Sitzung nicht gefunden.',
  'workspaceMigration.deepLink.missingBcfDraft': 'Dieser BCF-Entwurf wurde in diesem Browser nicht gefunden.',
  'workspaceMigration.deepLink.unknownPanel': 'Der Link verweist auf einen unbekannten Bereich.',
  'workspaceMigration.deepLink.conflicting': 'Der Link enthält widersprüchliche Ziele.',
  'workspaceMigration.deepLink.invalidId': 'Der Link enthält eine ungültige Elementkennung.',
} satisfies Catalogue;
