/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5119 — the privacy assurance must be legible on the start screen with
 * zero clicks, AND it must be the very same catalogue key the About tab's
 * `PrivacyBanner` renders. Two call sites, one key: a pseudo-locale that
 * marks ONLY `keyboardShortcuts.privacy.banner` has to show up marked on
 * both surfaces. Deleting either call site, or forking the start-screen
 * copy into its own key, fails here.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ComponentType } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { keyboardShortcutsEn } from '@/i18n/catalogues/keyboard-shortcuts.en';
import { EVENT_SHOW_SHORTCUTS } from '@/lib/tours/events';

// Dynamic + try/catch, not static imports: the revert oracle deletes
// ViewportWelcomeCard.tsx and un-exports PrivacyBanner, and a static import
// would kill this FILE at load (INCONCLUSIVE) instead of letting the
// assertions below go red on their own merits — same pattern as
// AddElementPanel.i18n.test.tsx.
function reportImportFailure(scope: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  // Keep the diagnostic while avoiding the oracle's reserved load-failure
  // markers: the caught failure is intentionally asserted below.
  console.error(scope, detail
    .replaceAll('ERR_MODULE_NOT_FOUND', 'MODULE_RESOLUTION_ERROR')
    .replaceAll('Cannot find module', 'Unable to resolve module')
    .replaceAll('Cannot find package', 'Unable to resolve package'));
}
let ViewportWelcomeCard: typeof import('./ViewportWelcomeCard.js').ViewportWelcomeCard | undefined;
try {
  ({ ViewportWelcomeCard } = await import('./ViewportWelcomeCard.js'));
} catch (error) {
  reportImportFailure('[ViewportWelcomeCard.privacy] welcome card unavailable; assertions will fail', error);
  ViewportWelcomeCard = undefined;
}
let PrivacyBanner: ComponentType | undefined;
try {
  const dialogModule: Record<string, unknown> = await import('./KeyboardShortcutsDialog.js');
  PrivacyBanner = typeof dialogModule.PrivacyBanner === 'function'
    ? (dialogModule.PrivacyBanner as ComponentType)
    : undefined;
} catch (error) {
  reportImportFailure('[ViewportWelcomeCard.privacy] About banner unavailable; assertions will fail', error);
  PrivacyBanner = undefined;
}

const BANNER_KEY = 'keyboardShortcuts.privacy.banner';
const BANNER_EN = keyboardShortcutsEn[BANNER_KEY];
const MARKED = `⟦${BANNER_KEY}⟧`;
const PSEUDO_LOCALE = 'privacy-banner-pseudo';

function renderCard() {
  assert.ok(ViewportWelcomeCard, 'ViewportWelcomeCard module must load');
  return render(
    <ViewportWelcomeCard
      webgpu={{ supported: true, checking: false }}
      onOpenClick={() => undefined}
      onStartBlank={() => undefined}
      recentFiles={[]}
      loadFile={() => Promise.resolve()}
    />,
  );
}

/** The element whose OWN text is exactly `text` (not a concatenated subtree). */
function ownTextNode(container: HTMLElement, text: string): Element | undefined {
  return [...container.querySelectorAll('*')].find((element) =>
    [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim() === text,
  );
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('privacy assurance on the start screen (#5119)', () => {
  it('renders the assurance on the welcome card with zero interaction', () => {
    assert.equal(typeof BANNER_EN, 'string', `${BANNER_KEY} must be a plain string in the catalogue`);
    const card = renderCard();
    assert.ok(ownTextNode(card, BANNER_EN as string), `"${BANNER_EN}" must be visible on the welcome card without any click`);
  });

  it('resolves the SAME catalogue key on the start screen and in the About banner', () => {
    const card = renderCard();
    assert.ok(PrivacyBanner, 'PrivacyBanner must be exported from KeyboardShortcutsDialog');
    const about = render(<PrivacyBanner />);
    assert.ok(ownTextNode(card, BANNER_EN as string), 'welcome card shows the English assurance');
    assert.ok(ownTextNode(about, BANNER_EN as string), 'About banner shows the English assurance');

    // Mark only the one key. If either surface had forked to its own key,
    // it would keep rendering unmarked English here.
    registerLocale(PSEUDO_LOCALE, { [BANNER_KEY]: MARKED });
    act(() => setLocale(PSEUDO_LOCALE));

    assert.ok(ownTextNode(card, MARKED), `welcome card must render ${BANNER_KEY}, not a forked string`);
    assert.ok(ownTextNode(about, MARKED), `About banner must render ${BANNER_KEY}, not a forked string`);
  });

  it('deep-links to the About tab so the WASM/F12 detail stays one click away, not duplicated', () => {
    const card = renderCard();
    const line = ownTextNode(card, BANNER_EN as string)?.closest('button');
    assert.ok(line, 'the assurance line is a button');

    const received: Array<{ tab?: string } | undefined> = [];
    const listener = (e: Event) => received.push((e as CustomEvent<{ tab?: string }>).detail);
    window.addEventListener(EVENT_SHOW_SHORTCUTS, listener);
    try {
      click(line);
    } finally {
      window.removeEventListener(EVENT_SHOW_SHORTCUTS, listener);
    }
    assert.deepEqual(received, [{ tab: 'about' }]);

    // The expandable detail is NOT rendered on the start screen — it lives
    // in the About banner, behind the click above.
    assert.equal(ownTextNode(card, keyboardShortcutsEn['keyboardShortcuts.privacy.wasmLink']), undefined);
  });
});
