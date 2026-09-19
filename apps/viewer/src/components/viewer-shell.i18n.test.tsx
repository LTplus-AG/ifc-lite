/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer shell's own top-level chrome reads the i18n catalogue (#4918
 * slice 5): `ChunkErrorBoundary`'s fallback UI and `ui/dialog.tsx`'s
 * screen-reader-only close label.
 *
 * Same pseudo-locale oracle shape as `MainToolbar.i18n.test.tsx`: mark every
 * English string, switch locale live, assert the marked form reappears.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { viewerShellEn } from '@/i18n/catalogues/viewer-shell.en';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { Dialog, DialogContent } from './ui/dialog';

type ShellKey = keyof typeof viewerShellEn;
const KEYS = Object.keys(viewerShellEn) as ShellKey[];
const mark = (key: ShellKey) => `⟦${key}|${viewerShellEn[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, mark(key)]));

function bodyText(): string {
  return document.body.textContent ?? '';
}

/** Throws a message `isChunkLoadError` recognizes as a stale-deployment chunk failure. */
function ThrowChunkError(): never {
  throw new Error('Failed to fetch dynamically imported module: https://example/chunk.js');
}

function ThrowGenericError(): never {
  throw new Error('boom');
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('ChunkErrorBoundary localization (#4918)', () => {
  it('translates the chunk-load-failure fallback and reload button', () => {
    render(
      <ChunkErrorBoundary label="Layers panel">
        <ThrowChunkError />
      </ChunkErrorBoundary>,
    );
    const english = bodyText();
    assert.ok(english.includes('Layers panel could not be loaded'));
    assert.ok(english.includes('This usually means the app was updated while your tab was open.'));
    assert.ok(english.includes('Reload'));

    registerLocale('chunk-error-pseudo', PSEUDO);
    act(() => setLocale('chunk-error-pseudo'));
    const after = bodyText();
    assert.ok(
      after.includes('⟦viewerShell.chunkError.loadFailed|Layers panel could not be loaded⟧'),
      'expected the marked+interpolated loadFailed text',
    );
    assert.ok(after.includes('viewerShell.chunkError.loadFailedDetail'));
    assert.ok(after.includes('viewerShell.chunkError.reload'));
  });

  it('translates the generic-crash fallback', () => {
    render(
      <ChunkErrorBoundary label="MCP playground">
        <ThrowGenericError />
      </ChunkErrorBoundary>,
    );
    const english = bodyText();
    assert.ok(english.includes('MCP playground stopped working'));
    assert.ok(english.includes('An unexpected error stopped it from rendering.'));

    registerLocale('chunk-error-generic-pseudo', PSEUDO);
    act(() => setLocale('chunk-error-generic-pseudo'));
    const after = bodyText();
    assert.ok(after.includes('⟦viewerShell.chunkError.crashed|MCP playground stopped working⟧'));
    assert.ok(after.includes('viewerShell.chunkError.crashedDetail'));
  });
});

describe('ui/dialog.tsx localization (#4918)', () => {
  it('translates the sr-only close label', () => {
    render(
      <Dialog open>
        <DialogContent>
          <div>content</div>
        </DialogContent>
      </Dialog>,
    );
    assert.ok(bodyText().includes(viewerShellEn['viewerShell.dialog.close']));

    registerLocale('dialog-close-pseudo', PSEUDO);
    act(() => setLocale('dialog-close-pseudo'));
    assert.ok(bodyText().includes(mark('viewerShell.dialog.close')));
  });
});
