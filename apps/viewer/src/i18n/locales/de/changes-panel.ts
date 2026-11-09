/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const changesPanelDe = {
  'changesPanel.title': 'Änderungen',
  'changesPanel.close': 'Änderungen schließen',
  'changesPanel.empty': 'Keine aufgezeichneten Bearbeitungen.',
  'changesPanel.rowCount': { one: '{count} Bearbeitung', other: '{count} Bearbeitungen' },
  'changesPanel.entity': '{type} #{id}',
  'changesPanel.georeference': 'Georeferenz',
  'changesPanel.modelMetadata': 'Modellmetadaten',
  'changesPanel.jump': 'Zu {entity} in {model} springen',
  'changesPanel.revert': 'Rückgängig machen',
  'changesPanel.revertUnavailable': 'Diese Bearbeitung kann nicht sicher rückgängig gemacht werden, solange neuere Bearbeitungen von ihr abhängen.',
  'changesPanel.revertStale': 'Die Bearbeitung hat sich geändert. Prüfen Sie die aktuelle Liste und versuchen Sie es erneut.',
  'changesPanel.revertPermission': 'Aktivieren Sie den Bearbeitungsmodus oder fordern Sie Bearbeitungszugriff an, bevor Sie Änderungen rückgängig machen.',
  'changesPanel.revertSharedRoom': 'Verlassen Sie den geteilten Raum, bevor Sie eine Bearbeitung rückgängig machen. Der Raum kann diese Umkehrung noch nicht synchronisieren.',
  'changesPanel.revertUnsupported': 'Diese Bearbeitung kann in dieser Leiste nicht rückgängig gemacht werden. Verwenden Sie Rückgängig, wenn sie der neueste Schritt ist.',
} satisfies Catalogue;
