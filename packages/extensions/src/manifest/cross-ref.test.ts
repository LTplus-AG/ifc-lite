/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Command cross-reference coverage.
 *
 * Only the *negative* direction was pinned before (a toolbar entry
 * pointing at a command nobody declares). Both positive directions were
 * unpinned: deleting the `entry.commands` branch, or dropping the
 * `if (sb.command)` guard on statusBar entries, left the whole suite
 * green while turning valid manifests into rejected ones.
 */

import { describe, expect, it } from 'vitest';
import { validateManifest } from './validate.js';

function base(contributes: unknown, entry: unknown): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'com.example.xref',
    name: 'XRef',
    description: 'Cross-reference fixture.',
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=2.0.0' },
    capabilities: ['model.read'],
    activation: ['onStartup'],
    contributes,
    entry,
  };
}

describe('crossReferenceCommands — declaration sources', () => {
  it('accepts a reference satisfied by contributes.commands', () => {
    const r = validateManifest(base(
      {
        commands: [{ id: 'ext.example.cmd', title: 'Run' }],
        toolbar: [{ command: 'ext.example.cmd', slot: 'toolbar.right' }],
      },
      {},
    ));
    if (!r.ok) console.error(r.errors);
    expect(r.ok).toBe(true);
  });

  // The `entry.commands` branch is a second, independent declaration
  // source: a manifest may point a toolbar button at a command whose
  // only declaration is the id → script-path map under `entry`.
  it('accepts a reference satisfied only by entry.commands', () => {
    const r = validateManifest(base(
      { toolbar: [{ command: 'ext.example.only-entry', slot: 'toolbar.right' }] },
      { commands: { 'ext.example.only-entry': 'src/cmd.js' } },
    ));
    if (!r.ok) console.error(r.errors);
    expect(r.ok).toBe(true);
  });

  it('still rejects a reference declared in neither place', () => {
    const r = validateManifest(base(
      { toolbar: [{ command: 'ext.example.ghost', slot: 'toolbar.right' }] },
      { commands: { 'ext.example.other': 'src/cmd.js' } },
    ));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === 'invalid_reference')).toBe(true);
    }
  });
});

describe('crossReferenceCommands — every referencing contribution kind', () => {
  it.each([
    ['toolbar', { command: 'ext.example.ghost', slot: 'toolbar.right' }],
    ['contextMenu', { command: 'ext.example.ghost', slot: 'contextMenu.entity' }],
    ['keybindings', { command: 'ext.example.ghost', key: 'ctrl+k' }],
    ['statusBar', { id: 'sb1', text: 'Hi', slot: 'statusBar.left', command: 'ext.example.ghost' }],
  ])('flags a dangling command referenced from contributes.%s', (kind, item) => {
    const r = validateManifest(base({ [kind]: [item] }, {}));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some(
        (e) => e.code === 'invalid_reference' && e.path === `contributes.${kind}`,
      )).toBe(true);
    }
  });
});

describe('crossReferenceCommands — optional statusBar command', () => {
  // `command` is optional on a statusBar item (a plain text indicator).
  // Dropping the `if (sb.command)` guard would push `undefined` into the
  // reference list and reject this perfectly valid manifest.
  it('accepts a statusBar item with no command at all', () => {
    const r = validateManifest(base(
      { statusBar: [{ id: 'sb1', text: 'Ready', slot: 'statusBar.left' }] },
      {},
    ));
    if (!r.ok) console.error(r.errors);
    expect(r.ok).toBe(true);
  });

  it('accepts a statusBar item whose command is declared', () => {
    const r = validateManifest(base(
      {
        commands: [{ id: 'ext.example.cmd', title: 'Run' }],
        statusBar: [{ id: 'sb1', text: 'Ready', slot: 'statusBar.left', command: 'ext.example.cmd' }],
      },
      {},
    ));
    if (!r.ok) console.error(r.errors);
    expect(r.ok).toBe(true);
  });
});
