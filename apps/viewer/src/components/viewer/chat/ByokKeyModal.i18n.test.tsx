/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "use your own API key" modal reads the i18n catalogue (#4918 chat
 * slice), sibling to `ByokCredentialForm.i18n.test.tsx`.
 *
 * A pseudo-locale marks every static `chat-byok.en.ts` key. The modal is
 * mounted open on the Anthropic tab with the walkthrough expanded (the only
 * way to reach its steps), the English strings are read, the locale is
 * switched live, and each marked string that was readable in English must
 * reappear marked.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { chatByokEn as ChatByokEnType } from '@/i18n/catalogues/chat-byok.en';
import { ByokKeyModal } from './ByokKeyModal.js';

// Dynamic + try/catch (not a static import): a revert of this slice's
// production change deletes chat-byok.en.ts entirely, and a static import
// would fail the whole test FILE to load (ERR_MODULE_NOT_FOUND) rather than
// let the assertions below fail on their own merits — see
// PropertyEditor.i18n.test.tsx for the same pattern.
let chatByokEn: typeof ChatByokEnType | undefined;
try {
  ({ chatByokEn } = await import('@/i18n/catalogues/chat-byok.en'));
} catch {
  chatByokEn = undefined;
}
const CATALOGUE = chatByokEn ?? ({} as typeof ChatByokEnType);

const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE)) {
    catalogue[key] = typeof value === 'string'
      ? marked(value)
      : { one: marked(value.one), other: marked(value.other) };
  }
  return catalogue;
}

/**
 * The dialog content renders through a portal onto `document.body`, not
 * into the container `render()` returns — every query below reads
 * `document.body` for that reason.
 */
function openWithWalkthrough(provider: 'anthropic' | 'openai' = 'anthropic'): void {
  render(
    <ByokKeyModal open onOpenChange={() => {}} initialProvider={provider} />,
  );
  const toggle = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('walkthrough'),
  )!;
  click(toggle);
}

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('BYOK key modal localization (#4918)', () => {
  it('renders every static chrome string in English by default', () => {
    assert.ok(chatByokEn, 'chat-byok.en.ts catalogue must exist');
    openWithWalkthrough();
    const text = document.body.textContent ?? '';
    assert.match(text, /Use your own API key/);
    assert.match(text, /Unlocks frontier models\. Your key stays in this browser/);
    assert.match(text, /Unlocks:/);
    assert.match(text, /Key stored only in this browser's/);
    assert.match(text, /Inspect any time in DevTools\./);
    assert.match(text, /Every request goes to/);
    assert.match(text, /The whole BYOK code path is short enough to read\./);
    assert.match(text, /Open the Anthropic console — opens in a new tab\./);
    assert.match(text, /Create Key/);
    assert.match(text, /Scope it to a single workspace/);
    assert.match(text, /Set a spending limit/);
    assert.match(text, /Copy the key, come back here/);
    assert.match(text, /Open console\.anthropic\.com/);
  });

  it('translates every static string when the locale switches, without remounting', () => {
    openWithWalkthrough();
    registerLocale('byok-key-modal-pseudo', pseudoLocale());
    act(() => setLocale('byok-key-modal-pseudo'));
    const text = document.body.textContent ?? '';

    assert.match(text, /⟦Use your own API key⟧/);
    assert.match(text, /⟦Unlocks frontier models\. Your key stays in this browser/);
    assert.match(text, /⟦Anthropic⟧/);
    assert.match(text, /⟦OpenAI⟧/);
    assert.match(text, /⟦Unlocks:⟧/);
    assert.match(text, /⟦Key stored only in this browser's⟧/);
    assert.match(text, /⟦localStorage⟧/);
    assert.match(text, /⟦Inspect any time in DevTools\.⟧/);
    assert.match(text, /⟦Every request goes to⟧/);
    assert.match(text, /⟦The whole BYOK code path is short enough to read\.⟧/);
    assert.match(text, /⟦Don't have a key\? 60-second walkthrough⟧/);
    assert.match(text, /⟦Open the Anthropic console — opens in a new tab\.⟧/);
    assert.match(text, /⟦Click⟧/);
    assert.match(text, /⟦Create Key⟧/);
    assert.match(text, /⟦, name it⟧/);
    assert.match(text, /⟦ifc-lite⟧/);
    assert.match(text, /⟦ Scope it to a single workspace/);
    assert.match(text, /⟦Set a spending limit/);
    assert.match(text, /⟦Copy the key, come back here/);
    assert.match(text, /⟦Open console\.anthropic\.com⟧/);
  });

  it('translates the OpenAI tab, which has no workspace copy', () => {
    openWithWalkthrough('openai');
    registerLocale('byok-key-modal-openai-pseudo', pseudoLocale());
    act(() => setLocale('byok-key-modal-openai-pseudo'));
    const text = document.body.textContent ?? '';
    assert.match(text, /⟦Anthropic⟧/);
    assert.match(text, /⟦OpenAI⟧/);
    assert.match(text, /⟦Open the OpenAI console — opens in a new tab\.⟧/);
  });
});
