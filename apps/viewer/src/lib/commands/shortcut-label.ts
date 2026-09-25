/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a keyboard command's keys are written on screen (#5836). Every tooltip,
 * palette row, menu item and the shortcuts dialog goes through here, so a key
 * hint is spelled once and follows the platform.
 */

import { chordOnPlatform, formatChord, isApplePlatform } from './chord';
import { KEY_COMMANDS, type KeyCommandDefinition, type KeyCommandId } from './keyboard-commands';

export type { KeyCommandId };

const BY_ID: ReadonlyMap<string, KeyCommandDefinition> = new Map(
  KEY_COMMANDS.map((command) => [command.id, command]),
);

export function keyCommand(id: KeyCommandId): KeyCommandDefinition {
  const command = BY_ID.get(id);
  // Unreachable: `KeyCommandId` is derived from the same table.
  if (!command) throw new Error(`Unknown keyboard command: ${id}`);
  return command;
}

/** All of a command's chords, e.g. `Del, Backspace, Space`, or `Alt+1…0` for a range. */
export function formatCommandKeys(command: KeyCommandDefinition, apple: boolean = isApplePlatform()): string {
  const keys = command.keys.filter((chord) => chordOnPlatform(chord, apple));
  if (command.display === 'range' && keys.length > 1) {
    const first = formatChord(keys[0], apple);
    const last = formatChord({ key: keys[keys.length - 1].key }, apple);
    return `${first}…${last}`;
  }
  return keys.map((chord) => formatChord(chord, apple)).join(', ');
}

/** The key hint for a command's tooltip or menu row. */
export function shortcutLabel(id: KeyCommandId, apple: boolean = isApplePlatform()): string {
  return formatCommandKeys(keyCommand(id), apple);
}

/**
 * Only the primary chord, for a hint with room for one key (the context
 * menu's Duplicate row names ⌘D, not its Shift/Alt direction variants).
 */
export function primaryShortcutLabel(id: KeyCommandId, apple: boolean = isApplePlatform()): string {
  const chord = keyCommand(id).keys.find((c) => chordOnPlatform(c, apple));
  // Unreachable while every command has a chord for both platform families,
  // which `keyboard-commands.test.ts` asserts.
  if (!chord) throw new Error(`Keyboard command ${id} has no chord on this platform`);
  return formatChord(chord, apple);
}
