/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The What's New tab inlines every package's release history
 * (`__RELEASE_HISTORY__`, over 1 MB in a real build), so the Info dialog
 * loads it as a lazy chunk instead of shipping it in the eager bundle
 * (`bundle/viewer-eager-js-bytes`). Observed here as behaviour: the dialog's
 * first synchronous render does not contain the tab yet, and the tab mounts
 * once its chunk resolves.
 *
 * Its own file on purpose: React.lazy caches a resolved module for the
 * process, so only the first render of the tab can observe the boundary.
 */
import '@/test/setup-dom.js';
// Vite `define` build-time constants (see vite.config.ts); stand-ins under Node.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
(globalThis as unknown as { __BUILD_DATE__: string }).__BUILD_DATE__ = '2026-01-01T00:00:00.000Z';
(globalThis as unknown as { __PACKAGE_VERSIONS__: Array<{ name: string; version: string }> }).__PACKAGE_VERSIONS__ = [
  { name: '@ifc-lite/viewer', version: '0.0.0-test' },
];
(globalThis as unknown as { __RELEASE_HISTORY__: unknown[] }).__RELEASE_HISTORY__ = [
  {
    name: '@ifc-lite/viewer',
    releases: [{ version: '0.0.0-test', highlights: [{ type: 'feature', text: 'Lazy release highlight' }] }],
  },
];

import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, waitFor } from '@/test/render.js';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog.js';

afterEach(cleanup);

const body = () => document.body.textContent ?? '';

it("loads the What's New tab as a lazy chunk, then shows the release history", async () => {
  render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="whatsnew" />);
  assert.match(body(), /What's New/, 'the dialog chrome renders at once');
  assert.doesNotMatch(body(), /rows below are per-package releases/, 'the tab body is not part of the first synchronous render');

  await waitFor(() => body().includes('rows below are per-package releases'), "the lazy What's New tab to mount");
  assert.match(body(), /You’re on viewer v0\.0\.0-test/);
});
