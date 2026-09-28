/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5848: pins which registered export dialogs actually render through the
 * shared `ExportDialogShell` chrome, by rendering each REGISTRY entry (not
 * the component file directly, so a future registry edit that points an id
 * at a different component is covered too), opening it, and looking for the
 * shell's `data-export-dialog-shell` marker.
 *
 * The list is every `kind: 'dialog'` registry entry, so a dialog added to the
 * registry without the shell fails here. Each one is opened through a trigger
 * the test supplies, the registry's own contract (`ExportDialogComponent`),
 * because `modified-ifc` renders no standing button while nothing has changed.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import { EXPORT_COMMANDS, type ExportDialogCommand } from './export-commands.js';

afterEach(() => {
  cleanup();
  useViewerStore.getState().resetViewerState();
});

const DIALOG_COMMANDS = EXPORT_COMMANDS.filter((c): c is ExportDialogCommand => c.kind === 'dialog');

describe('registered export dialogs use ExportDialogShell (#5848)', () => {
  it('the registry has dialog commands to check', () => {
    assert.ok(DIALOG_COMMANDS.length >= 8, `expected every export dialog, found ${DIALOG_COMMANDS.length}`);
  });

  for (const { id, Dialog } of DIALOG_COMMANDS) {
    it(`"${id}" renders through ExportDialogShell`, () => {
      const container = render(<Dialog surface="classic" trigger={<button type="button">open</button>} />);
      const trigger = container.querySelector('button');
      assert.ok(trigger, `"${id}" must render the supplied trigger`);
      click(trigger);
      assert.ok(
        document.body.querySelector('[data-export-dialog-shell]'),
        `"${id}" opened a dialog that does not carry the ExportDialogShell marker — ` +
          'it must be migrated onto ExportDialogShell.tsx',
      );
    });
  }
});
