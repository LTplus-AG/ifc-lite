/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Chat secondary text clears WCAG AA as rendered (#6205, the chat rows of
 * #4792's panel table). Each state is mounted for real: the ChatPanel footer
 * (idle, streaming, usage meter) and empty-state hint, the BYOK modal's
 * pricing hint with the walkthrough open, and the ModelSelector dropdown's
 * context-window readouts. The text is found by what it says and measured
 * against the backgrounds its rendered ancestors paint.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import type { ExtensionHostService } from '@/services/extensions/host.js';
import { clearApiKeys, updateApiKeys } from '@/services/api-keys.js';
import { DEFAULT_FREE_MODEL } from '@/lib/llm/models.js';
import { shortcutLabel } from '@/lib/commands/shortcut-label.js';
import { resolve } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { cleanup, click, render } from '@/test/render.js';
import { ChatPanel } from '@/components/viewer/ChatPanel.js';
import { ByokKeyModal } from '@/components/viewer/chat/ByokKeyModal.js';
import { ModelSelector } from '@/components/viewer/chat/ModelSelector.js';
import { closeContrastBrowser, warmContrastBrowser } from './render-harness.js';
import {
  assertRenderedTextClears,
  assertForcedClassReddens,
  snapshotRenderedDom,
  THEMES,
  VIEWER_SHELL_SURFACE,
} from './rendered-text-contrast.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

const originalFetch = globalThis.fetch;
let initialState: ReturnType<typeof useViewerStore.getState>;

before(() => { initialState = useViewerStore.getState(); });
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  clearApiKeys();
  useViewerStore.setState(initialState, true);
});
before(warmContrastBrowser, { timeout: 300_000 });
after(closeContrastBrowser);

/**
 * ChatPanel paints its own `bg-background`. Its only host is ScriptPanel's
 * chat column, whose root is `h-full flex bg-background` (ScriptPanel.tsx),
 * inside the viewer shell ({@link VIEWER_SHELL_SURFACE}, ViewerLayout.tsx).
 * The usage poll's fetch is stubbed, as in ChatPanel.i18n.test.tsx.
 */
function mountChat(state: Partial<ReturnType<typeof useViewerStore.getState>> = {}): string {
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
  useViewerStore.setState({ chatActiveModel: DEFAULT_FREE_MODEL.id, ...state });
  render(
    <div className="h-full flex bg-background">
      <BimReactContext.Provider value={{} as BimContext}>
        <ExtensionHostContext.Provider value={{} as ExtensionHostService}>
          <ChatPanel />
        </ExtensionHostContext.Provider>
      </BimReactContext.Provider>
    </div>,
  );
  return snapshotRenderedDom(VIEWER_SHELL_SURFACE);
}

/** The modal portals its own `bg-background` DialogContent onto body. */
function mountByokWalkthrough(provider: 'anthropic' | 'openai'): string {
  render(<ByokKeyModal open onOpenChange={() => {}} initialProvider={provider} />);
  const toggle = [...document.body.querySelectorAll('button')]
    .find((b) => b.textContent === resolve('chatByok.keyModal.walkthroughToggle'));
  assert.ok(toggle, 'walkthrough toggle renders');
  click(toggle);
  return snapshotRenderedDom();
}

/**
 * Both providers keyed, so every BYOK row is the fully styled (not the
 * greyed-out locked) variant; no free models are configured in tests. The
 * open SelectContent portals its own `bg-popover` onto body.
 */
function openModelSelector(): string {
  updateApiKeys({ anthropicKey: 'sk-ant-api03-contrast', openaiKey: 'sk-contrast' });
  const ui = render(<ModelSelector />);
  const trigger = ui.querySelector('[role="combobox"]');
  assert.ok(trigger, 'model selector trigger renders');
  click(trigger);
  return snapshotRenderedDom();
}

const CONTEXT_WINDOW = /^\d+[KM]$/;
const PRICING_HINTS = {
  anthropic: 'Pay-as-you-go on Anthropic billing. New accounts get $5 free credit.',
  openai: 'OpenAI requires prepaid credits or a payment method on your OpenAI account.',
} as const;

describe('chat secondary text contrast (#6205)', () => {
  for (const theme of THEMES) {
    it(`ChatPanel idle footer hints and empty-state hint clear AA in ${theme}`, async () => {
      const html = mountChat();
      await assertRenderedTextClears(theme, html, [
        resolve('chat.panel.shiftEnterHint'),
        shortcutLabel('chat.focusInput'),
        resolve('chat.panel.emptyStateHint'),
      ], WCAG_AA_NORMAL_TEXT);
    });

    it(`ChatPanel "Streaming..." status clears AA in ${theme}`, async () => {
      const html = mountChat({ chatStatus: 'streaming' });
      await assertRenderedTextClears(theme, html, [resolve('chat.panel.streamingIndicator')], WCAG_AA_NORMAL_TEXT);
    });

    it(`ChatPanel usage percentage readout clears AA in ${theme}`, async () => {
      const html = mountChat({ chatUsage: { type: 'requests', used: 42, limit: 100, pct: 42, resetAt: 0 } });
      await assertRenderedTextClears(theme, html, ['42%'], WCAG_AA_NORMAL_TEXT);
    });

    it(`ByokKeyModal pricing hint clears AA in ${theme}`, async () => {
      for (const provider of ['anthropic', 'openai'] as const) {
        const html = mountByokWalkthrough(provider);
        await assertRenderedTextClears(theme, html, [PRICING_HINTS[provider]], WCAG_AA_NORMAL_TEXT);
        cleanup();
      }
    });

    it(`ModelSelector contextWindow readouts clear AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, openModelSelector(), [CONTEXT_WINDOW], WCAG_AA_NORMAL_TEXT);
    });
  }
});

describe('chat secondary text contrast negative controls (#6205)', () => {
  const controls: Array<{ className: string; site: string; mount: () => void; host?: string; text: () => string }> = [
    {
      className: 'text-[10px] text-muted-foreground/40',
      site: 'ChatPanel "Shift+Enter new line" hint',
      mount: () => mountChat(),
      host: VIEWER_SHELL_SURFACE,
      text: () => resolve('chat.panel.shiftEnterHint'),
    },
    {
      className: 'text-xs text-muted-foreground/60',
      site: 'ChatPanel empty-state hint',
      mount: () => mountChat(),
      host: VIEWER_SHELL_SURFACE,
      text: () => resolve('chat.panel.emptyStateHint'),
    },
    {
      className: 'text-muted-foreground/50 text-[10px]',
      site: 'ModelSelector contextWindow readout',
      mount: openModelSelector,
      text: () => '200K',
    },
  ];
  for (const { className, site, mount, host, text } of controls) {
    for (const theme of THEMES) {
      it(`non-vacuousness: ${className} on ${site} reddens in ${theme}`, async (t) => {
        mount();
        const ratios = await assertForcedClassReddens(theme, text(), className, WCAG_AA_NORMAL_TEXT, host);
        t.diagnostic(ratios.map((r) => `${r.toFixed(2)}:1`).join(', '));
      });
    }
  }
});
