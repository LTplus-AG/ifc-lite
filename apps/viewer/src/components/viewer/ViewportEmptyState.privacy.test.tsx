/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins #5119: the privacy assurance must be readable on the start screen
 * with zero clicks, and it must be the SAME catalogue key the About-tab
 * `PrivacyBanner` (`KeyboardShortcutsDialog.tsx`) renders — not a forked
 * string that can drift.
 *
 * The second test proves the "same key" part directly rather than by
 * coincidence of matching English text: it overrides
 * `keyboardShortcuts.privacy.banner` with a unique marker via a registered
 * locale and asserts BOTH surfaces show that marker. A start screen that
 * hardcodes its own copy (a fork) would still show the untranslated English
 * sentence here and fail the assertion; a start screen with the key removed
 * entirely would also fail.
 */
import '@/test/setup-dom.js';
// Vite `define` build-time constants the About tab reads (see vite.config.ts):
// under plain Node they don't exist, so stand ins are needed before
// `KeyboardShortcutsDialog` renders (same pattern as its own i18n test).
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
(globalThis as unknown as { __BUILD_DATE__: string }).__BUILD_DATE__ = '2026-01-01T00:00:00.000Z';
(globalThis as unknown as { __PACKAGE_VERSIONS__: Array<{ name: string; version: string }> }).__PACKAGE_VERSIONS__ = [
  { name: '@ifc-lite/viewer', version: '0.0.0-test' },
];
(
  globalThis as unknown as {
    __RELEASE_HISTORY__: Array<{
      name: string;
      releases: Array<{ version: string; highlights: Array<{ type: 'feature' | 'fix' | 'perf'; text: string }> }>;
    }>;
  }
).__RELEASE_HISTORY__ = [{ name: '@ifc-lite/viewer', releases: [] }];

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { ViewportEmptyState, type ViewportEmptyStateProps } from './ViewportEmptyState.js';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog.js';

const PRIVACY_TEXT = 'Your IFC data never leaves your device.';
const PRIVACY_MARKER = '⟦privacy-marker-5119⟧';

const emptyStateProps: ViewportEmptyStateProps = {
  handleDragEnter: () => {},
  handleDragOver: () => {},
  handleDragLeave: () => {},
  handleDrop: () => {},
  fileInputRef: { current: null },
  handleFileSelect: () => {},
  isDragging: false,
  // `checking: true` keeps the WebGPU-unsupported banner, `WebGpuDisabledCaption`
  // and `TourInvite` (each gated on `!checking`) out of the render, so this
  // test exercises only the empty-state chrome the privacy line lives in.
  webgpu: { supported: true, checking: true, reason: null, category: null },
  showTroubleshooting: false,
  setShowTroubleshooting: () => {},
  handleOpenClick: () => {},
  handleStartBlank: () => {},
  recentFiles: [],
  loadFile: async () => {},
};

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('start-screen privacy assurance (#5119)', () => {
  it('renders the privacy sentence with zero clicks', () => {
    const container = render(<ViewportEmptyState {...emptyStateProps} />);
    assert.match(container.textContent ?? '', new RegExp(PRIVACY_TEXT.replace('.', '\\.')));
  });

  it('shares one catalogue key with the About-tab banner: both surfaces track a locale override to the same key', () => {
    registerLocale('privacy-marker-pseudo', { 'keyboardShortcuts.privacy.banner': PRIVACY_MARKER });
    setLocale('privacy-marker-pseudo');

    const about = render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="about" />);
    assert.ok(
      about.textContent?.includes(PRIVACY_MARKER),
      'About-tab PrivacyBanner did not pick up the overridden key',
    );

    const emptyState = render(<ViewportEmptyState {...emptyStateProps} />);
    assert.ok(
      emptyState.textContent?.includes(PRIVACY_MARKER),
      'start screen did not pick up the overridden key — it may be forking the string instead of sharing it',
    );
  });
});
