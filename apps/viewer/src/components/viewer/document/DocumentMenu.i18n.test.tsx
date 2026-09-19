/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Regression coverage for the #4918 document-menu localization slice. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { Toaster } from '@/components/ui/toast.js';
import { registerLocale, setLocale } from '@/i18n';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { DocumentMenu } from './DocumentMenu.js';

const DOCUMENT: DocumentSpec = {
  version: DOCUMENT_VERSION,
  id: 'document-1',
  name: 'Coordination report',
  page: { size: 'A4', orientation: 'portrait' },
  blocks: [],
};

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('DocumentMenu localization (#4918)', () => {
  it('renders registered-locale action copy and falls back to English per missing key', () => {
    registerLocale('document-menu-test', {
      'documentMenu.actions': 'Dokumentaktionen',
      'documentMenu.actionsTitle': 'Dokument bearbeiten',
      'documentMenu.rename': 'Umbenennen',
      'documentMenu.duplicate': 'Duplizieren',
    });
    setLocale('document-menu-test');

    const container = render(<DocumentMenu document={DOCUMENT} onUpsert={() => {}} onDelete={() => {}} onActivate={() => {}} />);
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Dokumentaktionen"]');
    assert.ok(trigger, 'the trigger uses the registered locale');
    assert.equal(trigger.title, 'Dokument bearbeiten');
    act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
    act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));

    const menuText = document.body.textContent ?? '';
    assert.match(menuText, /Umbenennen/);
    assert.match(menuText, /Duplizieren/);
    assert.match(menuText, /Delete/, 'an untranslated key falls back to its English catalogue value');
    assert.doesNotMatch(menuText, /Rename|Duplicate/, 'translated actions do not leak their English source copy');
  });

  it('wraps an import parser error in localized copy instead of exposing only English', async () => {
    registerLocale('document-menu-error-test', {
      'documentMenu.importFailedWithReason': 'Import fehlgeschlagen: {reason}',
    });
    setLocale('document-menu-error-test');
    const container = render(<><DocumentMenu document={DOCUMENT} onUpsert={() => {}} onDelete={() => {}} onActivate={() => {}} /><Toaster /></>);
    const input = container.querySelector<HTMLInputElement>('[data-document-import]');
    assert.ok(input);
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['not json'], 'broken.json', { type: 'application/json' })] });
    await act(async () => {
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.match(container.textContent ?? '', /Import fehlgeschlagen:/);
    assert.doesNotMatch(container.textContent ?? '', /^Unexpected token/);
  });
});
