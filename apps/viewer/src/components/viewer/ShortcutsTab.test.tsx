/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Shortcuts tab is generated from the keyboard command table (#5836): it
 * lists the bindings the handlers implement, including the ones the old
 * hand-written list left out, and writes keys for the platform it runs on.
 */
import '@/test/setup-dom.js';
// Vite `define` build-time constants the dialog's other tabs read (see
// `KeyboardShortcutsDialog.i18n.test.tsx`).
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
(globalThis as unknown as { __BUILD_DATE__: string }).__BUILD_DATE__ = '2026-01-01T00:00:00.000Z';
(globalThis as unknown as { __PACKAGE_VERSIONS__: unknown[] }).__PACKAGE_VERSIONS__ = [];
(globalThis as unknown as { __RELEASE_HISTORY__: unknown[] }).__RELEASE_HISTORY__ = [];

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { WORKSPACE_PANELS, workspacePanelForShortcutCode } from '@/lib/panels/registry';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog.js';
import { setPlatform } from '@/test/platform.js';

afterEach(() => {
  cleanup();
  setPlatform(null);
});

function renderShortcuts(platform: string) {
  setPlatform(platform);
  render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="shortcuts" />);
  const rows = [...document.body.querySelectorAll('div.flex.items-center.justify-between')]
    .map((row) => ({ text: row.querySelector('span')?.textContent ?? '', keys: row.querySelector('kbd')?.textContent ?? '' }))
    .filter((row) => row.keys);
  assert.ok(rows.length > 0, 'the Shortcuts tab rendered rows');
  return rows;
}

/** Every individual chord shown, splitting `A, B` cells. */
const chords = (rows: { keys: string }[]) => new Set(rows.flatMap((row) => row.keys.split(', ')));

describe('generated Shortcuts tab (#5836)', () => {
  it('lists bindings the handlers implement that the hand-written list omitted', () => {
    const shown = chords(renderShortcuts('Win32'));
    for (const chord of ['Backspace', 'Ctrl+D', 'Ctrl+F', '/', 'N', 'Shift+N', 'Ctrl+Shift+F', 'Ctrl+L', '↑']) {
      assert.ok(shown.has(chord), `"${chord}" is listed; shown: ${[...shown].join(', ')}`);
    }
  });

  it('writes the command modifier as Ctrl off Apple platforms, never ⌘', () => {
    const rows = renderShortcuts('Win32');
    assert.ok(chords(rows).has('Ctrl+Z'));
    assert.deepEqual(rows.filter((row) => row.keys.includes('⌘')), []);
  });

  it('writes it as ⌘ on Apple platforms, never Ctrl+', () => {
    const rows = renderShortcuts('MacIntel');
    assert.ok(chords(rows).has('⌘Z'));
    assert.deepEqual(rows.filter((row) => row.keys.includes('Ctrl+')), []);
  });

  // Ported from the retired `keyboard-shortcuts-list.test.ts` (#5606).
  it('names every Alt-digit panel by its registry title, in key order', () => {
    const row = renderShortcuts('Win32').find((r) => r.keys === 'Alt+1…0');
    assert.ok(row, 'the Alt+1…0 row exists');
    let from = 0;
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
      const id = workspacePanelForShortcutCode(`Digit${d}`);
      const title = WORKSPACE_PANELS.find((p) => p.id === id)?.title;
      assert.ok(title, `Digit${d} opens a registered panel`);
      const at = row.text.indexOf(title, from);
      assert.ok(at >= from, `"${title}" appears in key order in: ${row.text}`);
      from = at + title.length;
    }
    assert.doesNotMatch(row.text, /\bIDS\b/);
  });
});
