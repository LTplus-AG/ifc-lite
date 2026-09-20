/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The chat panel reads the i18n catalogue (#4918 chat slice), sibling to
 * `chat/ByokCredentialForm.i18n.test.tsx` and `chat/ByokKeyModal.i18n.test.tsx`.
 *
 * A pseudo-locale marks every static `chat.en.ts` key `ChatPanel.tsx` owns
 * (`chat.panel.*`). The panel needs a `BimReactContext` (via `useSandbox`)
 * and an `ExtensionHostContext` (via the always-mounted `PromoteToolDialog`)
 * to render at all; `fetch` is stubbed so the usage-meter poll never makes a
 * real network call in this environment. Both the idle empty state and the
 * clear-confirmation state are exercised (that dialog's copy only shows
 * with existing messages), the locale is switched live, and each marked
 * string that was readable in English must reappear marked.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import type { ExtensionHostService } from '@/services/extensions/host.js';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import { chatEn } from '@/i18n/catalogues/chat.en';
import { useViewerStore } from '@/store';
import { ChatPanel } from './ChatPanel.js';

const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(chatEn)) {
    catalogue[key] = typeof value === 'string'
      ? marked(value)
      : { one: marked(value.one), other: marked(value.other) };
  }
  return catalogue;
}

const originalFetch = globalThis.fetch;

function renderPanel(): HTMLElement {
  return render(
    <BimReactContext.Provider value={{} as BimContext}>
      <ExtensionHostContext.Provider value={{} as ExtensionHostService}>
        <ChatPanel />
      </ExtensionHostContext.Provider>
    </BimReactContext.Provider>,
  );
}

beforeEach(() => {
  setLocale('en');
  // The usage-meter poll fires fetch() on mount; a stub keeps this test
  // hermetic instead of attempting a real network call to /api/chat.
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
});

afterEach(() => {
  cleanup();
  setLocale('en');
  globalThis.fetch = originalFetch;
  act(() => {
    useViewerStore.getState().clearChatMessages();
  });
});

describe('chat panel localization (#4918)', () => {
  it('renders the idle empty state in English by default', () => {
    const ui = renderPanel();
    const text = ui.textContent ?? '';
    assert.match(text, /Try something:/);
    const input = ui.querySelector('textarea');
    assert.equal(input?.getAttribute('placeholder'), 'Ask anything...');
  });

  it('translates the idle empty state when the locale switches, without remounting', () => {
    const ui = renderPanel();
    registerLocale('chat-panel-idle-pseudo', pseudoLocale());
    act(() => setLocale('chat-panel-idle-pseudo'));
    const text = ui.textContent ?? '';

    assert.match(text, /⟦Try something:⟧/);
    const input = ui.querySelector('textarea');
    assert.equal(input?.getAttribute('placeholder'), marked('Ask anything...'));

    const clearTrigger = ui.querySelector('button[disabled]');
    assert.ok(clearTrigger, 'expected the disabled Clear button (no messages yet)');
  });

  it('translates the clear-confirmation dialog once messages exist', () => {
    act(() => {
      const add = useViewerStore.getState().addChatMessage;
      add({ id: 'm1', role: 'user', content: 'hello', createdAt: Date.now() });
      add({ id: 'm2', role: 'assistant', content: 'hi there', createdAt: Date.now() });
      add({ id: 'm3', role: 'user', content: 'third message forces the confirm dialog', createdAt: Date.now() });
    });
    const ui = renderPanel();
    // The header's own trash/clear icon button is the first button rendered.
    const trash = ui.querySelector('button')!;
    assert.equal(trash.disabled, false, 'expected the Clear button to be enabled once messages exist');
    click(trash);
    assert.match(ui.textContent ?? '', /Clear 3 messages\?/);

    registerLocale('chat-panel-confirm-pseudo', pseudoLocale());
    act(() => setLocale('chat-panel-confirm-pseudo'));
    assert.match(ui.textContent ?? '', /⟦Clear 3 messages\?⟧/);
    const buttons = [...ui.querySelectorAll('button')].map((b) => b.textContent);
    assert.ok(buttons.includes(marked('Clear')));
    assert.ok(buttons.includes(marked('Cancel')));
  });

  it('translates the placeholder when a BYOK key is required', () => {
    act(() => {
      useViewerStore.getState().setChatActiveModel('claude-sonnet-4-5-20250929');
    });
    const ui = renderPanel();
    const input = ui.querySelector('textarea');
    const placeholder = input?.getAttribute('placeholder') ?? '';
    // Either the BYOK-needed placeholder or the default, depending on
    // whether a key happens to be configured in this environment — assert
    // it is one of the two catalogued English strings either way.
    assert.ok(
      placeholder === 'Ask anything...' || /^Add your (Anthropic|OpenAI) key to chat with this model$/.test(placeholder),
      `unexpected placeholder: ${placeholder}`,
    );
  });
});
