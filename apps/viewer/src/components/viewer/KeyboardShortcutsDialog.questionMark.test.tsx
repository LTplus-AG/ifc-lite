/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `?` is documented as the shortcuts key (`KEYBOARD_SHORTCUTS`, the welcome
 * tour), so pressing it must open the Info dialog on the Shortcuts tab, not
 * About (#5606). Drives the real `useKeyboardShortcutsDialog` hook wired to the
 * real dialog, exactly as `ViewerLayout` does.
 */
import '@/test/setup-dom.js';
// Vite `define` build-time constants the About tab reads (see
// `KeyboardShortcutsDialog.i18n.test.tsx`): without them a wrong-tab render
// would throw instead of failing the assertion below.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
(globalThis as unknown as { __BUILD_DATE__: string }).__BUILD_DATE__ = '2026-01-01T00:00:00.000Z';
(globalThis as unknown as { __PACKAGE_VERSIONS__: unknown[] }).__PACKAGE_VERSIONS__ = [];
(globalThis as unknown as { __RELEASE_HISTORY__: unknown[] }).__RELEASE_HISTORY__ = [];

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { KeyboardShortcutsDialog, useKeyboardShortcutsDialog } from './KeyboardShortcutsDialog.js';

function Harness() {
  const dialog = useKeyboardShortcutsDialog();
  return <KeyboardShortcutsDialog open={dialog.open} onClose={dialog.close} initialTab={dialog.tab} />;
}

function pressQuestionMark(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
  });
}

// `KeyboardShortcutsDialog`'s shell moved onto Radix `Dialog` (#5817), which
// portals its content straight to `document.body` rather than rendering it
// inside `render()`'s own container div — so the tab strip has to be found
// document-wide, not scoped to the returned container.
function activeTab(): string | null | undefined {
  return document.querySelector('[role="tab"][data-state="active"]')?.textContent;
}

afterEach(() => {
  cleanup();
});

describe('`?` opens the Info dialog on Shortcuts (#5606)', () => {
  it('opens on the Shortcuts tab', () => {
    render(<Harness />);
    assert.equal(activeTab(), undefined, 'the dialog starts closed');
    pressQuestionMark();
    assert.equal(activeTab(), 'Shortcuts');
  });

  it('closes again on a second press', () => {
    render(<Harness />);
    pressQuestionMark();
    pressQuestionMark();
    assert.equal(activeTab(), undefined);
  });
});
