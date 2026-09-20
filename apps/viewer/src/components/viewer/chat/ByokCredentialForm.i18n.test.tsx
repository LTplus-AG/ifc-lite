/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BYOK credential form reads the i18n catalogue (#4918 chat slice).
 *
 * A pseudo-locale marks every static `chat-byok.en.ts` key this component
 * renders. Both the empty-key state (paste, workspace guidance) and the
 * saved-key state (replace, configured, remove) are rendered so every
 * conditional branch's text is exercised, the locale is switched live, and
 * each marked string that was readable in English must reappear marked.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { chatByokEn as ChatByokEnType } from '@/i18n/catalogues/chat-byok.en';
import { ByokCredentialForm, type CredentialFormMeta } from './ByokCredentialForm.js';

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

// chat-byok.en.ts carries no plural entries (unlike chat.en.ts's sibling
// attachmentRows count), so every value here is a plain string.
function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE)) {
    catalogue[key] = marked(value);
  }
  return catalogue;
}

const META: CredentialFormMeta = {
  label: 'Anthropic',
  keyPrefix: 'sk-ant-api03-',
  placeholder: 'sk-ant-api03-...',
};

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('BYOK credential form localization (#4918)', () => {
  it('translates the empty-key state: label, aria-labels, workspace guidance', () => {
    assert.ok(chatByokEn, 'chat-byok.en.ts catalogue must exist');
    const ui = render(
      <ByokCredentialForm provider="anthropic" meta={META} savedKey="" savedWorkspaceId="" />,
    );
    assert.equal(ui.textContent?.includes('Paste your key'), true);

    const toggle = ui.querySelector('button[aria-label]');
    assert.equal(toggle?.getAttribute('aria-label'), 'Show key');

    const workspaceInput = ui.querySelector('#byok-anthropic-workspace') as HTMLInputElement;
    assert.equal(workspaceInput.getAttribute('placeholder'), 'wrkspc_...');
    assert.equal(ui.textContent?.includes('Workspace ID'), true);
    assert.equal(ui.textContent?.includes('— optional'), true);
    assert.equal(
      ui.textContent?.includes('Only needed if your key reaches more than one workspace'),
      true,
    );
    const save = [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    assert.ok(save, 'expected a Save button');

    registerLocale('byok-credential-empty-pseudo', pseudoLocale());
    act(() => setLocale('byok-credential-empty-pseudo'));

    assert.equal(ui.textContent?.includes(marked('Paste your key')), true);
    assert.equal(toggle?.getAttribute('aria-label'), marked('Show key'));
    assert.equal(workspaceInput.getAttribute('placeholder'), marked('wrkspc_...'));
    assert.equal(ui.textContent?.includes(marked('Workspace ID')), true);
    assert.equal(ui.textContent?.includes(marked('— optional')), true);
    assert.equal(
      ui.textContent?.includes(marked('Only needed if your key reaches more than one workspace — Anthropic then rejects every request until one is named. A key created for a single workspace needs nothing here.')),
      true,
    );
    assert.equal(ui.textContent?.includes(marked('Save')), true);
  });

  it('translates the saved-key state: replace label, configured line, remove button', () => {
    const ui = render(
      <ByokCredentialForm
        provider="anthropic"
        meta={META}
        savedKey={`sk-ant-api03-${'A'.repeat(60)}`}
        savedWorkspaceId="wrkspc_01abc"
      />,
    );
    assert.equal(ui.textContent?.includes('Replace existing key'), true);
    assert.equal(ui.textContent?.includes('Configured:'), true);
    const remove = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Remove'));
    assert.ok(remove, 'expected a Remove button');

    registerLocale('byok-credential-saved-pseudo', pseudoLocale());
    act(() => setLocale('byok-credential-saved-pseudo'));

    assert.equal(ui.textContent?.includes(marked('Replace existing key')), true);
    assert.equal(ui.textContent?.includes(marked('Configured:')), true);
    assert.equal(ui.textContent?.includes(marked('Remove')), true);
  });

  it('translates the invalid-key and invalid-workspace-id messages', () => {
    const ui = render(
      <ByokCredentialForm provider="anthropic" meta={META} savedKey="" savedWorkspaceId="" />,
    );
    const keyInput = ui.querySelector(`#byok-anthropic-input`) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(keyInput, 'not-a-real-key');
      keyInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(
      ui.textContent?.includes("That doesn't look like a Anthropic key (expected prefix"),
      true,
    );

    registerLocale('byok-credential-invalid-pseudo', pseudoLocale());
    act(() => setLocale('byok-credential-invalid-pseudo'));
    const text = ui.textContent ?? '';
    assert.match(text, /⟦That doesn.t look like a Anthropic key \(expected prefix sk-ant-api03-\)\.⟧/);
  });
});
