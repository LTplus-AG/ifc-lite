/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setCollabEnabledOverride } from '@/lib/collab/config';
import { useViewerStore } from '@/store';
import { buildPanelCommands } from './commandPaletteCommandsPanels.js';
import { paletteSurfaceCommands, surfaceCommand, SURFACE_COMMANDS } from './surface-commands.js';
import type { CommandPaletteBuildParams } from './commandPaletteCommandsTypes.js';

const PANEL_IDS = [
  'panel:script', 'panel:lists', 'panel:gantt', 'panel:charts', 'panel:flow',
  'panel:document', 'panel:drawing', 'panel:properties', 'panel:tree',
  'panel:bcf', 'panel:ids', 'panel:clash', 'panel:compare', 'panel:changes', 'panel:model', 'panel:semantic', 'panel:changeSets',
  'panel:cost', 'panel:chat', 'panel:lens', 'panel:layers', 'panel:sources',
  'panel:zones', 'panel:loadReport', 'panel:pointclouds', 'panel:measurements',
  'panel:appearance', 'panel:collab', 'panel:extensions',
] as const;

function params(): CommandPaletteBuildParams {
  return {
    execute: () => {}, recentFiles: [], cachedNames: { current: new Set<string>() },
    extensionCommands: [], extensionHost: null, canEditInSession: true,
    cesiumAvailable: false, activateRightPanel: () => {}, activateBottomPanel: () => {},
    runExport: () => {},
  };
}

beforeEach(() => setCollabEnabledOverride(false));
afterEach(() => {
  setCollabEnabledOverride(null);
  useViewerStore.setState({ sidebarActivePanel: 'properties', ganttPanelVisible: false });
});

describe('shared panel command homes (#5870)', () => {
  it('generates all static panel rows in browse order and preserves the collab gate', () => {
    const definitions = SURFACE_COMMANDS.filter((command) => command.id.startsWith('panel:'));
    assert.deepEqual(definitions.map((command) => command.id), PANEL_IDS);
    assert.throws(() => surfaceCommand('panel:tree', 'ribbon'), /not registered for ribbon/,
      'Tree collapse belongs to the palette and is never a ribbon command');

    const hidden = paletteSurfaceCommands({ canEditInSession: true, collabEnabled: false }, () => {})
      .filter((command) => command.id.startsWith('panel:'));
    const available = paletteSurfaceCommands({ canEditInSession: true, collabEnabled: true }, () => {})
      .filter((command) => command.id.startsWith('panel:'));
    assert.deepEqual(hidden.map((command) => command.id), PANEL_IDS.filter((id) => id !== 'panel:collab'));
    assert.deepEqual(available.map((command) => command.id), PANEL_IDS);

    const rendered = buildPanelCommands(params()).filter((command) => command.id.startsWith('panel:'));
    assert.deepEqual(rendered.map((command) => command.id), hidden.map((command) => command.id),
      'the real palette builder renders every enabled table row exactly once');
    for (const row of rendered) {
      const definition = definitions.find((command) => command.id === row.id);
      assert.ok(definition);
      assert.equal(row.labelKey, definition.labelKey);
      assert.equal(row.icon, definition.icon);
    }
  });

  it('routes panel commands to the real right and bottom panel store actions', () => {
    useViewerStore.setState({ sidebarActivePanel: 'properties', ganttPanelVisible: false });
    const rows = paletteSurfaceCommands({ canEditInSession: true }, () => {}, {
      activateRightPanel: (panel) => { useViewerStore.getState().toggleWorkspacePanel(panel, 'palette'); },
      activateBottomPanel: (panel) => { useViewerStore.getState().toggleBottomPanel(panel, 'palette'); },
    });
    const validation = rows.find((command) => command.id === 'panel:ids');
    const gantt = rows.find((command) => command.id === 'panel:gantt');
    assert.ok(validation);
    assert.ok(gantt);
    validation.action();
    gantt.action();
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'validation');
    assert.equal(useViewerStore.getState().ganttPanelVisible, true);
  });
});
