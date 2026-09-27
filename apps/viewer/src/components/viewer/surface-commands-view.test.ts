/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { paletteSurfaceCommands, SURFACE_COMMANDS } from './surface-commands.js';

const VIEW_IDS = [
  'view:home', 'view:fit', 'view:frame', 'view:stacked', 'view:exploded',
  'view:solo', 'view:projection', 'view:top', 'view:bottom', 'view:front',
  'view:back', 'view:left', 'view:right', 'view:world', 'view:lighting',
  'view:spacemouse',
] as const;

const originalCallbacks = useViewerStore.getState().cameraCallbacks;
afterEach(() => useViewerStore.setState({ cameraCallbacks: originalCallbacks }));

describe('shared View palette commands (#5870)', () => {
  it('keeps every View row in browse order and gates the 3D world row on availability', () => {
    const tableRows = SURFACE_COMMANDS.filter((command) => command.category === 'View');
    assert.deepEqual(tableRows.map((command) => command.id), [...VIEW_IDS]);

    const unavailable = paletteSurfaceCommands({ canEditInSession: true, cesiumAvailable: false }, () => {});
    const available = paletteSurfaceCommands({ canEditInSession: true, cesiumAvailable: true }, () => {});
    assert.deepEqual(unavailable.filter((command) => command.category === 'View').map((command) => command.id),
      VIEW_IDS.filter((id) => id !== 'view:world'));
    assert.deepEqual(available.filter((command) => command.category === 'View').map((command) => command.id),
      [...VIEW_IDS]);
    for (const row of available.filter((command) => command.category === 'View')) {
      const definition = tableRows.find((command) => command.id === row.id);
      assert.ok(definition);
      assert.equal(row.labelKey, definition.labelKey);
      assert.equal(row.icon, definition.icon);
      assert.equal(row.shortcut, 'shortcut' in definition ? definition.shortcut : undefined);
    }
  });

  it('routes a camera preset through the registered viewport callback', () => {
    const presets: string[] = [];
    useViewerStore.setState({ cameraCallbacks: { setPresetView: (preset) => { presets.push(preset); } } });
    const top = paletteSurfaceCommands({ canEditInSession: true, cesiumAvailable: false }, () => {})
      .find((command) => command.id === 'view:top');
    assert.ok(top);
    top.action();
    assert.deepEqual(presets, ['top']);
  });
});
