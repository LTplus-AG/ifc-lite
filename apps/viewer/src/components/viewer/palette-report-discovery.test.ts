/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLocale, setLocale } from '@/i18n';
import { commandPaletteDe } from '@/i18n/locales/de/command-palette';
import { commandPaletteRu } from '@/i18n/locales/ru/command-palette';
import { paletteSurfaceCommands } from './surface-commands';
import { useViewerStore } from '@/store';
import { searchCommands } from './commandPaletteSearch';

// Generic English 'Location zones' names the dedicated zone authoring panel.
// Properties separately exposes selected-entity memberships and straddler volume splits.
// DE/RU here register only command-palette metadata (not panel-title catalogues):
// their zone aliases intentionally find that translated Properties inspection path.
for (const [locale, cases] of [
  ['en', [['report error', 'panel:error-report'], ['failed load report', 'panel:error-report'], ['resume recent report', 'panel:error-report'],
    ['location zones', 'panel:zones'], ['volume split', 'panel:properties'], ['tag grouping', 'panel:tree'], ['exploded gap', 'panel:tree'], ['source sync', 'panel:tree'], ['hide others', 'vis:isolate']]],
  ['de', [['Fehler melden', 'panel:error-report'], ['Lagezonen', 'panel:properties'], ['Volumenaufteilung', 'panel:properties'], ['Tag-Gruppierung', 'panel:tree']]],
  ['ru', [['сообщить об ошибке', 'panel:error-report'], ['Зоны расположения', 'panel:properties'], ['разделение объёма', 'panel:properties'], ['синхронизация источника', 'panel:tree']]],
] as const) test(`#8947 ${locale} task phrases rank the canonical report and discovery destinations`, () => {
  try {
    registerLocale('de', commandPaletteDe); registerLocale('ru', commandPaletteRu);
    setLocale(locale);
    const commands = paletteSurfaceCommands({ canEditInSession: true, cesiumAvailable: false }, () => {});
    for (const [query, id] of cases) {
      assert.equal(searchCommands(commands, query, [])[0]?.id, id, query);
    }
  } finally { setLocale('en'); }
});

test('#8947 zone management and entity volume inspection use distinct canonical routes', () => {
  const original = useViewerStore.getState();
  try {
    setLocale('en');
    const commands = paletteSurfaceCommands({ canEditInSession: true }, () => {}, {
      activateRightPanel: panel => useViewerStore.getState().showWorkspacePanel(panel, 'palette'),
    });
    const zones = searchCommands(commands, 'location zones', [])[0];
    assert.equal(zones?.id, 'panel:zones', 'zone authoring has its own destination');
    assert.ok(zones);
    zones.action();
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'zones');
    const inspection = searchCommands(commands, 'volume split', [])[0];
    assert.equal(inspection?.id, 'panel:properties', 'straddler breakdown lives with entity properties');
    assert.ok(inspection);
    inspection.action();
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'properties');
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false);
  } finally {
    useViewerStore.setState(original);
    setLocale('en');
  }
});
