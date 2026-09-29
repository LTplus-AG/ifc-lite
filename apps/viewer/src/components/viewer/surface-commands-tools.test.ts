/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Crosshair, Slice } from 'lucide-react';
import { useViewerStore } from '@/store';
import { paletteSurfaceCommands, SURFACE_COMMANDS } from './surface-commands.js';

const TOOL_IDS = [
  'tool:select', 'tool:walk', 'model:reposition', 'tool:measure',
  'tool:section', 'tool:annotate', 'tool:add-element', 'tool:wall', 'tool:slab', 'tool:column', 'tool:beam', 'tool:room',
  'tool:opening', 'tool:door', 'tool:window',
  'tool:edit-mode', 'tool:split',
] as const;
const isCoreTool = (id: string) => id.startsWith('tool:') || id === 'model:reposition';
const originalTool = useViewerStore.getState().activeTool;
afterEach(() => useViewerStore.setState({ activeTool: originalTool }));

describe('shared Tools palette commands (#5870)', () => {
  it('keeps browse order and hides authoring commands in a read-only session', () => {
    assert.deepEqual(SURFACE_COMMANDS.filter((command) => isCoreTool(command.id)).map((command) => command.id),
      [...TOOL_IDS]);
    const split = SURFACE_COMMANDS.find((command) => command.id === 'tool:split');
    assert.ok(split);
    assert.deepEqual([...split.surfaces], ['palette'], 'Split belongs to the shared palette, not either toolbar');
    const readonlyRows = paletteSurfaceCommands({ canEditInSession: false }, () => {})
      .filter((command) => isCoreTool(command.id));
    const editableRows = paletteSurfaceCommands({ canEditInSession: true }, () => {})
      .filter((command) => isCoreTool(command.id));
    assert.deepEqual(readonlyRows.map((command) => command.id), TOOL_IDS.slice(0, 6));
    assert.deepEqual(editableRows.map((command) => command.id), [...TOOL_IDS]);
    for (const row of editableRows) {
      const definition = SURFACE_COMMANDS.find((command) => command.id === row.id);
      assert.ok(definition);
      assert.equal(row.labelKey, definition.labelKey);
      assert.equal(row.icon, definition.icon);
    }
    const reposition = editableRows.find((row) => row.id === 'model:reposition');
    assert.equal(reposition?.labelKey, 'commandPalette.tool.reposition.label');
    assert.equal(reposition?.icon, Crosshair);
    const splitRow = editableRows.find((row) => row.id === 'tool:split');
    assert.equal(splitRow?.labelKey, 'commandPalette.tool.split.label');
    assert.equal(splitRow?.icon, Slice);
    assert.equal(splitRow?.shortcut, 'tool.split');
  });

  it('runs the registered tool action through the viewer store', () => {
    useViewerStore.setState({ activeTool: 'select' });
    const measure = paletteSurfaceCommands({ canEditInSession: true }, () => {})
      .find((command) => command.id === 'tool:measure');
    assert.ok(measure);
    measure.action();
    assert.equal(useViewerStore.getState().activeTool, 'measure');
  });
});
