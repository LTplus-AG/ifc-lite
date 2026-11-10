/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 3Dconnexion SDK licence (section 2) requires its attribution line in
 * the host's About box, verbatim and in English, while the integration is
 * present (#9131). The About tab must show it, and switching the viewer's
 * language must not change it.
 */
import '@/test/setup-dom.js';
// Vite `define` build-time constants the About tab reads (see vite.config.ts).
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
(globalThis as unknown as { __BUILD_DATE__: string }).__BUILD_DATE__ = '2026-01-01T00:00:00.000Z';
(globalThis as unknown as { __PACKAGE_VERSIONS__: Array<{ name: string; version: string }> }).__PACKAGE_VERSIONS__ = [];

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { AboutTab } from './KeyboardShortcutsDialogTabs.js';

const ATTRIBUTION =
  '3D input device development tools and related technology are provided under license from 3Dconnexion. © 3Dconnexion 1992 - 2025. All rights reserved.';

afterEach(() => {
  act(() => setLocale('en'));
  cleanup();
});

describe('About tab — 3Dconnexion attribution (#9131)', () => {
  it('shows the licence attribution verbatim', () => {
    const container = render(<AboutTab />);
    assert.ok((container.textContent ?? '').includes(ATTRIBUTION));
  });

  it('keeps the attribution in English under another locale', () => {
    registerLocale('zz', { 'keyboardShortcuts.about.license': 'XX licence' });
    const container = render(<AboutTab />);
    act(() => setLocale('zz'));
    const text = container.textContent ?? '';
    assert.ok(text.includes('XX licence'), 'the locale switch took effect');
    assert.ok(text.includes(ATTRIBUTION));
  });
});
