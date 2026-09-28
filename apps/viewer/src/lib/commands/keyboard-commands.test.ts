/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The keyboard command table's invariants (#5836, charter #5610): one chord
 * means one thing per context, and every chord reads correctly on both
 * platform families.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chordIdentity, formatChord } from './chord.js';
import { KEY_COMMANDS, type KeyCommandDefinition, type KeyContext } from './keyboard-commands.js';
import { formatCommandKeys, primaryShortcutLabel, shortcutLabel } from './shortcut-label.js';

/** Every (context, chord) claimed by more than one command. */
function collisions(commands: readonly KeyCommandDefinition[]): string[] {
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  for (const command of commands) {
    for (const chord of command.keys) {
      const slot = `${command.when} ${chordIdentity(chord)}`;
      const previous = owner.get(slot);
      if (previous) clashes.push(`${slot}: ${previous} and ${command.id}`);
      else owner.set(slot, command.id);
    }
  }
  return clashes;
}

/** A new dispatcher context must join the collision control, too (#5878). */
const DISPATCHER_CONTEXTS = {
  global: true,
  overlay: true,
  'tool.walk': true,
  'tool.measure': true,
  'tool.addElement': true,
  'tool.spaceSketch': true,
  command: true,
  'command.wall.place': true, // Representative command-specific context.
  drawing2d: true,
  flight: true,
  'search.cycle': true,
  'search.field': true,
  'panel.reposition': true,
  'panel.chat': true,
  'panel.schedule': true,
  'panel.script': true,
  'schedule.drag': true,
} satisfies Record<KeyContext, true>;

describe('keyboard command table (#5836)', () => {
  it('no two commands share a chord within one context', () => {
    assert.deepEqual(collisions(KEY_COMMANDS), []);
  });

  it('the collision check catches a clash (control)', () => {
    const [undo] = KEY_COMMANDS;
    const clash: KeyCommandDefinition = { ...undo, id: 'test.clash' };
    assert.equal(collisions([undo, clash]).length, 1);
    // The same chord in another context is not a clash: a tool context wins
    // over `global` while the tool is active.
    assert.deepEqual(collisions([undo, { ...clash, when: 'tool.spaceSketch' }]), []);
  });

  it('rejects a duplicated chord in every dispatcher when context (#5878)', () => {
    const [undo] = KEY_COMMANDS;
    for (const when of Object.keys(DISPATCHER_CONTEXTS) as KeyContext[]) {
      const first = { ...undo, when };
      const second = { ...first, id: `test.clash.${when}` };
      assert.equal(collisions([first, second]).length, 1, when);
      assert.deepEqual(collisions([undo, second]), when === 'global'
        ? [`${when} ${chordIdentity(undo.keys[0])}: ${undo.id} and ${second.id}`]
        : [], when);
    }
  });

  it('command ids are unique', () => {
    const ids = KEY_COMMANDS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('every command formats to a non-empty label on both platforms', () => {
    for (const command of KEY_COMMANDS) {
      assert.ok(command.keys.length > 0, `${command.id} has keys`);
      for (const apple of [true, false]) {
        assert.ok(formatCommandKeys(command, apple).trim(), `${command.id} (apple=${apple})`);
      }
    }
  });
});

describe('platform key glyphs (#5836)', () => {
  it('writes the command modifier as ⌘ on Apple and Ctrl elsewhere', () => {
    assert.equal(shortcutLabel('edit.undo', true), '⌘Z');
    assert.equal(shortcutLabel('edit.undo', false), 'Ctrl+Z');
    assert.equal(shortcutLabel('edit.redo', true), '⇧⌘Z');
    assert.equal(shortcutLabel('edit.redo', false), 'Ctrl+Shift+Z, Ctrl+Y');
  });

  it('writes Alt as ⌥ on Apple, and positional digits as the digit', () => {
    assert.equal(shortcutLabel('ui.openPanel', true), '⌥1…0');
    assert.equal(shortcutLabel('ui.openPanel', false), 'Alt+1…0');
    assert.equal(shortcutLabel('ui.toggleSidebar', false), 'Alt+\\');
  });

  it('shows a platform-only chord on its own platform only (CodeMirror redo)', () => {
    assert.equal(shortcutLabel('script.redo', true), '⇧⌘Z');
    assert.equal(shortcutLabel('script.redo', false), 'Ctrl+Y');
  });

  it('names only the primary chord where a hint has room for one key', () => {
    assert.equal(primaryShortcutLabel('edit.duplicate', false), 'Ctrl+D');
    assert.equal(primaryShortcutLabel('edit.duplicate', true), '⌘D');
  });

  it('lists every chord of a multi-key command', () => {
    assert.equal(shortcutLabel('basket.add', false), '=, +');
    assert.equal(shortcutLabel('visibility.hideSelection', false), 'Del, Backspace, Space');
    assert.equal(shortcutLabel('ui.closeAllPanels', false), 'Esc Esc');
    assert.equal(formatChord({ key: 'n', shift: true }, false), 'Shift+N');
  });
});
