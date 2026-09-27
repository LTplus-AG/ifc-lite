/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Manifest shortcut parsing and collision checks for the live dispatcher (#5841). */
import type { KeyChord } from './chord';
import { chordIdentity } from './chord';
import { KEY_COMMANDS } from './keyboard-commands';
import { runnableKeyboardBindings } from './dispatcher';

const NAMED_KEYS: Readonly<Record<string, string>> = {
  esc: 'escape', escape: 'escape', space: ' ', enter: 'enter', return: 'enter',
  delete: 'delete', backspace: 'backspace', up: 'arrowup', down: 'arrowdown',
  left: 'arrowleft', right: 'arrowright',
};

/** Reject unknown or ambiguous manifest strings instead of registering a dead key. */
export function parseExtensionKey(raw: string): KeyChord | null {
  const parts = raw.trim().toLowerCase().split('+').map((part) => part.trim());
  const keyText = parts.pop();
  if (!keyText) return null;
  const modifiers = new Set(parts);
  if (modifiers.size !== parts.length || [...modifiers].some((part) =>
    !['ctrl', 'control', 'cmd', 'command', 'meta', 'mod', 'shift', 'alt', 'option'].includes(part)
  )) return null;
  const key = NAMED_KEYS[keyText] ?? keyText;
  if (key.length !== 1 && !['escape', 'enter', 'delete', 'backspace', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) return null;
  return {
    key,
    ...([...modifiers].some((part) => ['ctrl', 'control', 'cmd', 'command', 'meta', 'mod'].includes(part)) ? { mod: true as const } : {}),
    ...([...modifiers].some((part) => part === 'alt' || part === 'option') ? { alt: true as const } : {}),
    ...(modifiers.has('shift') ? { shift: true as const } : {}),
  };
}

function collisionIdentity(chord: KeyChord): string {
  // Alt+digit is positional in the built-in table but can be entered as a
  // character by an extension author. Those still claim the same physical key.
  const key = chord.alt && chord.key.startsWith('code:Digit')
    ? chord.key.slice('code:Digit'.length)
    : chord.alt && chord.key === 'code:Backslash' ? '\\' : chord.key;
  return chordIdentity({ ...chord, key });
}

/** A reserved built-in or already registered global binding owns this chord. */
export function extensionKeyCollision(chord: KeyChord): string | null {
  const identity = collisionIdentity(chord);
  for (const command of KEY_COMMANDS) {
    if (command.when === 'global' && command.keys.some((key) => collisionIdentity(key) === identity)) return command.id;
  }
  for (const binding of runnableKeyboardBindings()) {
    if (binding.layer === 'global' && binding.keys.some((key) => collisionIdentity(key) === identity)) return binding.id;
  }
  return null;
}
