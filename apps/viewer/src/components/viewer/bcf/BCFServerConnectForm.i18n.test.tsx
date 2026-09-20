/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { bcfEn as BcfEnType } from '@/i18n/catalogues/bcf.en';
import { BCFServerConnectForm } from './BCFServerConnectForm.js';

let bcfEn: typeof BcfEnType | undefined;
try {
  ({ bcfEn } = await import('@/i18n/catalogues/bcf.en'));
} catch {
  bcfEn = undefined;
}

const CATALOGUE = bcfEn ?? ({} as typeof BcfEnType);
const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE)) {
    catalogue[key] =
      typeof value === 'string'
        ? marked(value)
        : (Object.fromEntries(
            Object.entries(value).map(([category, form]) => [category, marked(form as string)]),
          ) as TranslationValue);
  }
  return catalogue;
}

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('BCF server connect form localization (#4918)', () => {
  it('renders English labels and placeholders by default', () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const ui = render(
      <BCFServerConnectForm initialServerUrl="" initialUsername="" onSignedIn={() => {}} />,
    );
    assert.match(ui.textContent ?? '', /Server URL/);
    assert.match(ui.textContent ?? '', /Connect/);
    const urlInput = ui.querySelector('#bcf-server-url');
    assert.equal(urlInput?.getAttribute('placeholder'), 'https://example.com/bcf');
  });

  it('updates labels, placeholders, and the vendor-app notice when the active locale changes', () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const ui = render(
      <BCFServerConnectForm initialServerUrl="" initialUsername="" onSignedIn={() => {}} />,
    );
    registerLocale('bcf-server-connect-pseudo', pseudoLocale());
    act(() => setLocale('bcf-server-connect-pseudo'));

    const text = document.body.textContent ?? '';
    assert.match(text, /⟦Server URL⟧/);
    assert.match(text, /⟦Sign-in method⟧/);
    assert.match(text, /⟦Connect⟧/);

    const urlInput = ui.querySelector('#bcf-server-url');
    assert.equal(
      urlInput?.getAttribute('placeholder'),
      marked(CATALOGUE['bcf.serverConnect.serverUrlPlaceholder'] as string),
    );
  });
});
