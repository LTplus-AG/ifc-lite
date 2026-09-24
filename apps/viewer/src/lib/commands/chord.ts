/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Key chords: the structured form of a keyboard shortcut, and how one is
 * written for the user (#5836).
 *
 * A chord is data, never a display string, so the same binding can be shown
 * as `⌘⇧Z` on Apple platforms and `Ctrl+Shift+Z` everywhere else. That split
 * is the whole reason this is not a `string`: the viewer used to print `⌘Z`
 * on Windows too, because the glyph was typed into each tooltip by hand.
 */

export interface KeyChord {
  /**
   * `KeyboardEvent.key`, lower-cased (`'z'`, `'escape'`, `' '`, `'?'`), or a
   * `KeyboardEvent.code` prefixed `code:` (`'code:Digit1'`) where a binding is
   * positional rather than a character — Alt+digit produces `¡` on a Mac.
   */
  readonly key: string;
  /** The platform command modifier: ⌘ on Apple platforms, Ctrl elsewhere. */
  readonly mod?: true;
  readonly shift?: true;
  readonly alt?: true;
  /** Two presses in quick succession (Esc Esc). */
  readonly double?: true;
}

/**
 * True on macOS and iOS/iPadOS, where the command modifier is ⌘. Read at call
 * time, not cached, so a test (or a desktop shell) can set the platform.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const NAMED_KEYS: Record<string, { apple: string; other: string }> = {
  escape: { apple: 'Esc', other: 'Esc' },
  enter: { apple: '↩', other: 'Enter' },
  ' ': { apple: 'Space', other: 'Space' },
  delete: { apple: 'Del', other: 'Del' },
  backspace: { apple: '⌫', other: 'Backspace' },
  arrowup: { apple: '↑', other: '↑' },
  arrowdown: { apple: '↓', other: '↓' },
  arrowleft: { apple: '←', other: '←' },
  arrowright: { apple: '→', other: '→' },
  shift: { apple: '⇧', other: 'Shift' },
  '-': { apple: '−', other: '−' },
};

function keyGlyph(key: string, apple: boolean): string {
  if (key.startsWith('code:')) {
    const code = key.slice('code:'.length);
    if (code.startsWith('Digit')) return code.slice('Digit'.length);
    if (code === 'Backslash') return '\\';
    return code;
  }
  const named = NAMED_KEYS[key];
  if (named) return apple ? named.apple : named.other;
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * The chord as the user reads it: `⌘⇧Z` / `⌥1` on Apple platforms (modifier
 * glyphs run together, in Apple's ⌥⇧⌘ order), `Ctrl+Shift+Z` / `Alt+1`
 * elsewhere.
 */
export function formatChord(chord: KeyChord, apple: boolean = isApplePlatform()): string {
  const key = keyGlyph(chord.key, apple);
  let single: string;
  if (apple) {
    single = `${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${key}`;
  } else {
    const parts: string[] = [];
    if (chord.mod) parts.push('Ctrl');
    if (chord.alt) parts.push('Alt');
    if (chord.shift) parts.push('Shift');
    parts.push(key);
    single = parts.join('+');
  }
  return chord.double ? `${single} ${single}` : single;
}

/** Platform-independent identity of a chord, for collision checks. */
export function chordIdentity(chord: KeyChord): string {
  return [
    chord.mod ? 'mod' : '',
    chord.alt ? 'alt' : '',
    chord.shift ? 'shift' : '',
    chord.double ? 'double' : '',
    chord.key,
  ].join('|');
}
