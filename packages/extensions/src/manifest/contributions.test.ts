/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-contribution-kind field requirements.
 *
 * The fixture suite covered exactly two contribution rules (a bad slot
 * and a malformed `when`). Every required-field check — commands.title,
 * keybindings.key, exporters.mimeType, statusBar.text, and the rest —
 * could be deleted with the whole suite still green. A missing
 * `exporters.mimeType` reaching the host means an export contribution
 * that produces a file the browser cannot type.
 */

import { describe, expect, it } from 'vitest';
import { validateManifest } from './validate.js';

function withContributes(contributes: unknown, entry: unknown = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'com.example.contrib',
    name: 'Contrib',
    description: 'Contribution fixture.',
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=2.0.0' },
    capabilities: ['model.read'],
    activation: ['onStartup'],
    contributes,
    entry,
  };
}

function pathsFor(contributes: unknown, entry: unknown = {}): string[] {
  const r = validateManifest(withContributes(contributes, entry));
  return r.ok ? [] : r.errors.map((e) => e.path);
}

const CMD = { id: 'ext.example.cmd', title: 'Run' };

describe('contributes.commands', () => {
  it('requires id and title on every command', () => {
    const paths = pathsFor({ commands: [{ id: 'ext.example.cmd' }] });
    expect(paths).toContain('contributes.commands[0].title');
  });

  it('rejects a blank title', () => {
    const paths = pathsFor({ commands: [{ id: 'ext.example.cmd', title: '  ' }] });
    expect(paths).toContain('contributes.commands[0].title');
  });

  it('rejects a non-array commands value', () => {
    const paths = pathsFor({ commands: {} });
    expect(paths).toContain('contributes.commands');
  });

  it('accepts a well-formed command', () => {
    expect(validateManifest(withContributes({ commands: [CMD] })).ok).toBe(true);
  });
});

describe('contributes.toolbar', () => {
  it('requires command', () => {
    const paths = pathsFor({ commands: [CMD], toolbar: [{ slot: 'toolbar.right' }] });
    expect(paths).toContain('contributes.toolbar[0].command');
  });

  // The valid fixtures only ever use toolbar.left / toolbar.right, so
  // dropping 'toolbar.center' from the allow-list went unnoticed.
  it.each(['toolbar.left', 'toolbar.right', 'toolbar.center'])(
    'accepts the documented slot "%s"',
    (slot) => {
      const r = validateManifest(withContributes({
        commands: [CMD],
        toolbar: [{ command: CMD.id, slot }],
      }));
      if (!r.ok) console.error(slot, r.errors);
      expect(r.ok).toBe(true);
    },
  );

  it('rejects an unknown toolbar slot', () => {
    const paths = pathsFor({ commands: [CMD], toolbar: [{ command: CMD.id, slot: 'toolbar.middle' }] });
    expect(paths).toContain('contributes.toolbar[0].slot');
  });

  it('rejects a missing slot outright', () => {
    const paths = pathsFor({ commands: [CMD], toolbar: [{ command: CMD.id }] });
    expect(paths).toContain('contributes.toolbar[0].slot');
  });
});

describe('contributes.dock', () => {
  it('requires id, title and widget', () => {
    const paths = pathsFor({ dock: [{ slot: 'dock.left' }] });
    expect(paths).toContain('contributes.dock[0].id');
    expect(paths).toContain('contributes.dock[0].title');
    expect(paths).toContain('contributes.dock[0].widget');
  });

  it.each(['dock.left', 'dock.right', 'dock.bottom'])('accepts the documented slot "%s"', (slot) => {
    const r = validateManifest(withContributes({
      dock: [{ id: 'panel', title: 'Panel', widget: 'ui/panel.json', slot }],
    }));
    if (!r.ok) console.error(slot, r.errors);
    expect(r.ok).toBe(true);
  });

  it('rejects a toolbar slot used on a dock contribution', () => {
    const paths = pathsFor({
      dock: [{ id: 'panel', title: 'Panel', widget: 'ui/panel.json', slot: 'toolbar.left' }],
    });
    expect(paths).toContain('contributes.dock[0].slot');
  });
});

describe('contributes.contextMenu', () => {
  it.each(['contextMenu.entity', 'contextMenu.canvas', 'contextMenu.tree'])(
    'accepts the documented slot "%s"',
    (slot) => {
      const r = validateManifest(withContributes({
        commands: [CMD],
        contextMenu: [{ command: CMD.id, slot }],
      }));
      if (!r.ok) console.error(slot, r.errors);
      expect(r.ok).toBe(true);
    },
  );

  it('requires command', () => {
    const paths = pathsFor({ contextMenu: [{ slot: 'contextMenu.entity' }] });
    expect(paths).toContain('contributes.contextMenu[0].command');
  });
});

describe('contributes.keybindings', () => {
  // Without `key` the host has nothing to bind — the contribution is
  // silently inert.
  it('requires the key stroke', () => {
    const paths = pathsFor({ commands: [CMD], keybindings: [{ command: CMD.id }] });
    expect(paths).toContain('contributes.keybindings[0].key');
  });

  it('requires the command', () => {
    const paths = pathsFor({ keybindings: [{ key: 'ctrl+k' }] });
    expect(paths).toContain('contributes.keybindings[0].command');
  });

  it('accepts a well-formed keybinding', () => {
    const r = validateManifest(withContributes({
      commands: [CMD],
      keybindings: [{ command: CMD.id, key: 'ctrl+k' }],
    }));
    if (!r.ok) console.error(r.errors);
    expect(r.ok).toBe(true);
  });
});

describe('contributes.lenses', () => {
  it.each(['id', 'name', 'evaluator'])('requires "%s"', (field) => {
    const item: Record<string, string> = { id: 'l1', name: 'Lens', evaluator: 'src/l.js' };
    delete item[field];
    expect(pathsFor({ lenses: [item] })).toContain(`contributes.lenses[0].${field}`);
  });
});

describe('contributes.exporters', () => {
  it.each(['id', 'name', 'mimeType', 'extension', 'handler'])('requires "%s"', (field) => {
    const item: Record<string, string> = {
      id: 'e1', name: 'Exp', mimeType: 'text/csv', extension: 'csv', handler: 'src/e.js',
    };
    delete item[field];
    expect(pathsFor({ exporters: [item] })).toContain(`contributes.exporters[0].${field}`);
  });

  it('accepts a fully-specified exporter', () => {
    const r = validateManifest(withContributes({
      exporters: [{ id: 'e1', name: 'Exp', mimeType: 'text/csv', extension: 'csv', handler: 'src/e.js' }],
    }));
    if (!r.ok) console.error(r.errors);
    expect(r.ok).toBe(true);
  });
});

describe('contributes.idsValidators', () => {
  it.each(['id', 'name', 'handler'])('requires "%s"', (field) => {
    const item: Record<string, string> = { id: 'v1', name: 'V', handler: 'src/v.js' };
    delete item[field];
    expect(pathsFor({ idsValidators: [item] })).toContain(`contributes.idsValidators[0].${field}`);
  });
});

describe('contributes.statusBar', () => {
  it.each(['id', 'text'])('requires "%s"', (field) => {
    const item: Record<string, string> = { id: 'sb1', text: 'Ready', slot: 'statusBar.left' };
    delete item[field];
    expect(pathsFor({ statusBar: [item] })).toContain(`contributes.statusBar[0].${field}`);
  });

  it.each(['statusBar.left', 'statusBar.right'])('accepts the documented slot "%s"', (slot) => {
    const r = validateManifest(withContributes({ statusBar: [{ id: 'sb1', text: 'Ready', slot }] }));
    if (!r.ok) console.error(slot, r.errors);
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown statusBar slot', () => {
    const paths = pathsFor({ statusBar: [{ id: 'sb1', text: 'Ready', slot: 'statusBar.middle' }] });
    expect(paths).toContain('contributes.statusBar[0].slot');
  });
});

describe('contributes — shape guards', () => {
  it('rejects a non-object contributes', () => {
    const paths = pathsFor(['nope']);
    expect(paths).toContain('contributes');
  });

  it('rejects a non-object array item', () => {
    const paths = pathsFor({ commands: ['nope'] });
    expect(paths).toContain('contributes.commands[0]');
  });

  it('rejects a non-string when clause', () => {
    const paths = pathsFor({ commands: [CMD], toolbar: [{ command: CMD.id, slot: 'toolbar.left', when: 3 }] });
    expect(paths).toContain('contributes.toolbar[0].when');
  });

  it('accepts a well-formed when clause', () => {
    const r = validateManifest(withContributes({
      commands: [CMD],
      toolbar: [{ command: CMD.id, slot: 'toolbar.left', when: 'model.loaded' }],
    }));
    if (!r.ok) console.error(r.errors);
    expect(r.ok).toBe(true);
  });
});
