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
 * `MIGRATED_DIALOG_IDS` records the reviewable stacks for this issue. The
 * remaining `modified-ifc` review flow moves in the final stack, where this
 * list becomes every `kind: 'dialog'` registry entry.
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

const MIGRATED_DIALOG_IDS = ['glb', 'kmz', 'usd', 'energy', 'pdf', 'ifc', 'anonymized'] as const;

function dialogCommand(id: string): ExportDialogCommand {
  const command = EXPORT_COMMANDS.find((c) => c.id === id);
  assert.ok(command, `no registry entry for "${id}"`);
  assert.equal(command.kind, 'dialog', `"${id}" is not a dialog command`);
  return command as ExportDialogCommand;
}

describe('registered export dialogs use ExportDialogShell (#5848)', () => {
  for (const id of MIGRATED_DIALOG_IDS) {
    it(`"${id}" renders through ExportDialogShell`, () => {
      const { Dialog } = dialogCommand(id);
      const container = render(<Dialog surface="classic" />);
      const trigger = container.querySelector('button');
      assert.ok(trigger, `"${id}" must render a trigger`);
      click(trigger);
      assert.ok(
        document.body.querySelector('[data-export-dialog-shell]'),
        `"${id}" opened a dialog that does not carry the ExportDialogShell marker — ` +
          'it must be migrated onto ExportDialogShell.tsx',
      );
    });
  }
});
