/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PrivacyPanel` reads the i18n catalogue (#4918) — its own dedicated
 * file, same as `extensions-panels-chrome.i18n.test.tsx`'s doc comment
 * explains: 33 literals, the largest of the nine #4918 files converted
 * here, earns its own suite.
 *
 * Same oracle shape as `MainToolbar.i18n.test.tsx` / the sibling chrome
 * test: a pseudo-locale marks every `privacyPanel.*` string, the panel
 * is mounted in a state that surfaces both the "no active flavor" and
 * "active flavor with a draft overlay and pending proposals" branches
 * (two renders), the locale is switched live, and every marked string
 * that was readable in English must reappear marked.
 *
 * Toast messages and the `confirm()` prompt are real translated calls
 * (see the catalogue keys ending `...Toast`/`...Confirm`/`Error`) but
 * are not DOM text this renderer-focused oracle observes; left out of
 * `STATIC_KEYS` coverage, same as the sibling chrome file.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { InMemoryFlavorStorage, type Flavor } from '@ifc-lite/extensions';
import { createBimContext } from '@ifc-lite/sdk';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { extensionsPanelsEn } from '@/i18n/catalogues/extensions-panels.en';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { FlavorService } from '@/services/extensions/flavor-service.js';
import { PrivacyPanel } from './PrivacyPanel.js';
import { beforeSend } from '@/lib/analytics.js';
import { SettingsDialogHost } from '@/components/viewer/settings/SettingsDialog.js';
import { openSettings } from '@/lib/settings/open-settings.js';

class StubExtensionHost extends ExtensionHostService {
  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
    // Real `FlavorService`, in-memory storage — the default constructs
    // `IdbFlavorStorage`, which needs `indexedDB` (absent under happy-dom).
    (this as { flavors: FlavorService }).flavors = new FlavorService({
      storage: new InMemoryFlavorStorage(),
    });
  }

  override async clearPersistedActionLog(): Promise<void> {}
  override async clearPersistedAuditLog(): Promise<void> {}
}

function flavorFixture(overlayContent: string): Flavor {
  return {
    schemaVersion: 1,
    id: 'flavor-1',
    name: 'My flavor',
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    extensions: [],
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    promptOverlay: overlayContent
      ? { content: overlayContent, updatedAt: new Date('2026-01-01T00:00:00Z').toISOString() }
      : undefined,
    settings: {},
  };
}

type ExtKey = keyof typeof extensionsPanelsEn;
const ALL_KEYS = Object.keys(extensionsPanelsEn) as ExtKey[];
const SCOPE_KEYS = ALL_KEYS.filter((key) => key.startsWith('extensionsPanels.privacyPanel.'));
const STATIC_KEYS = SCOPE_KEYS.filter((key) => {
  const value = extensionsPanelsEn[key];
  return typeof value === 'string' && !value.includes('{');
});

const mark = (key: ExtKey) => `⟦${key}|${String(extensionsPanelsEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const el of container.querySelectorAll('button, input, textarea')) {
    act(() => (el as HTMLElement).focus());
    addReadable(document.body, out);
    act(() => (el as HTMLElement).blur());
  }
  return out;
}

/** See `extensions-panels-chrome.i18n.test.tsx` for why this must be a
 *  substring match: `helpLabel` is interpolated into a different
 *  catalogue's `"Help: {label}"` template, never shown bare. */
function foundText(strings: Set<string>, text: string): boolean {
  if (strings.has(text)) return true;
  for (const s of strings) {
    if (s.includes(text)) return true;
  }
  return false;
}

function openHelpHint(container: HTMLElement): void {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.getAttribute('aria-label')?.startsWith('Help: '),
  );
  assert.ok(button, 'expected a HelpHint trigger');
  act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
}

/**
 * Keys this render cannot show, each for a stated reason: a toast/confirm
 * message (see file doc comment), or the other branch of a mutually
 * exclusive state neither of the two mounted renders picks.
 */
const NOT_RENDERED_IN_THIS_STATE: ExtKey[] = [
  'extensionsPanels.privacyPanel.exportLogToast',
  'extensionsPanels.privacyPanel.clearLogConfirm',
  'extensionsPanels.privacyPanel.clearLogToast',
  'extensionsPanels.privacyPanel.noPreferencesToast',
  'extensionsPanels.privacyPanel.noActiveFlavorError',
  'extensionsPanels.privacyPanel.overlayClampedToast',
  'extensionsPanels.privacyPanel.overlaySavedToast',
  'extensionsPanels.privacyPanel.saveFailedToast',
];

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

/** Mount with an active flavor (draft overlay + pending proposals) —
 *  covers the "editing overlay" branch, its buttons, and the proposal
 *  review block. Waits for the async `refresh()` the panel runs on
 *  mount to settle. */
async function mountActiveFlavorFixture(host: StubExtensionHost): Promise<HTMLElement> {
  await host.flavors.put(flavorFixture('Existing overlay notes.'), 'seed');
  await host.flavors.activate('flavor-1');
  const container = render(
    <ExtensionHostContext.Provider value={host}>
      <PrivacyPanel />
    </ExtensionHostContext.Provider>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  openHelpHint(container);
  return container;
}

/** Force the "candidate preferences" review block open via `Extract
 *  from chat` against a store seeded with chat messages, so the
 *  `candidatePreferenceCount` / `ruleBasedWarning` / `discardButton` /
 *  `addToOverlayButton` keys render. */
async function revealProposals(container: HTMLElement): Promise<void> {
  const { useViewerStore } = await import('@/store');
  act(() => {
    useViewerStore.setState({
      chatMessages: [
        { id: 'm1', role: 'user', content: 'Always export CSV with semicolon separators.', ts: 0 } as never,
      ],
    } as never);
  });
  const extractButton = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Extract from chat'),
  );
  assert.ok(extractButton, 'expected an "Extract from chat" button');
  await act(async () => {
    extractButton.click();
    await Promise.resolve();
  });
  act(() => {
    useViewerStore.setState({ chatMessages: [] } as never);
  });
}

describe('PrivacyPanel localization (#4918)', () => {
  it('opens under Settings and persists analytics opt-out (#5866)', async () => {
    localStorage.removeItem('ifc-lite:analytics-opt-out');
    const host = new StubExtensionHost();
    render(
      <ExtensionHostContext.Provider value={host}>
        <SettingsDialogHost />
      </ExtensionHostContext.Provider>,
    );
    act(() => openSettings('privacy'));
    const dialog = document.querySelector('[data-settings-dialog]');
    assert.ok(dialog, 'Settings opens its Privacy section');
    const toggle = dialog.querySelector<HTMLElement>('#settings-analytics-opt-out');
    assert.ok(toggle, 'Privacy settings disclose product analytics and expose opt-out');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    click(toggle);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(localStorage.getItem('ifc-lite:analytics-opt-out'), 'true');
    assert.equal(beforeSend({ event: 'command_executed', properties: { command_id: 'test' } }), null);
    click(toggle);
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.equal(localStorage.getItem('ifc-lite:analytics-opt-out'), 'false');
  });

  it('localizes untouched baseline metadata in the active-flavor label', async () => {
    registerLocale('privacy-default-name', {
      'extensionsFlavors.flavorIndicator.defaultLabel': 'BASELINE LOCALISÉE',
    } as Catalogue);
    setLocale('privacy-default-name');
    const host = new StubExtensionHost();
    await host.flavors.resetToDefaults();
    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <PrivacyPanel />
      </ExtensionHostContext.Provider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(container.textContent ?? '', /BASELINE LOCALISÉE/);
  });

  it('lets a locale place the active flavor inside the complete overlay message', async () => {
    registerLocale('privacy-overlay-reordered', {
      'extensionsFlavors.flavorIndicator.defaultLabel': 'BASELINE LOCALISÉE',
      'extensionsPanels.privacyPanel.editingOverlayFor': '{name} — MODIFICATION DU CALQUE',
    } as Catalogue);
    setLocale('privacy-overlay-reordered');
    const host = new StubExtensionHost();
    await host.flavors.resetToDefaults();
    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <PrivacyPanel />
      </ExtensionHostContext.Provider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(container.textContent ?? '', /BASELINE LOCALISÉE — MODIFICATION DU CALQUE/);
  });

  it('translates every static key rendered across the no-flavor and active-flavor states', async () => {
    // Pass 1: no active flavor (the empty state + top-level chrome).
    const emptyHost = new StubExtensionHost();
    const emptyContainer = render(
      <ExtensionHostContext.Provider value={emptyHost}>
        <PrivacyPanel />
      </ExtensionHostContext.Provider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    openHelpHint(emptyContainer);

    // Pass 2: active flavor with a draft overlay + candidate proposals.
    const activeHost = new StubExtensionHost();
    const activeContainer = await mountActiveFlavorFixture(activeHost);
    await revealProposals(activeContainer);

    const english = new Set<string>([...readableStrings(emptyContainer), ...readableStrings(activeContainer)]);

    registerLocale('privacy-panel-pseudo', PSEUDO);
    act(() => setLocale('privacy-panel-pseudo'));
    const after = new Set<string>([...readableStrings(emptyContainer), ...readableStrings(activeContainer)]);

    const covered = new Set<ExtKey>();
    for (const key of STATIC_KEYS) {
      const text = String(extensionsPanelsEn[key]);
      if (!foundText(english, text)) continue;
      assert.ok(foundText(after, mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      covered.add(key);
    }

    for (const key of covered) {
      assert.ok(
        !NOT_RENDERED_IN_THIS_STATE.includes(key),
        `${key}: covered by this render, drop it from NOT_RENDERED_IN_THIS_STATE`,
      );
    }
  });

  it('accounts for every static key: rendered here, a toast/confirm, or a documented other-branch', async () => {
    const emptyHost = new StubExtensionHost();
    const emptyContainer = render(
      <ExtensionHostContext.Provider value={emptyHost}>
        <PrivacyPanel />
      </ExtensionHostContext.Provider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    openHelpHint(emptyContainer);

    const activeHost = new StubExtensionHost();
    const activeContainer = await mountActiveFlavorFixture(activeHost);
    await revealProposals(activeContainer);

    const english = new Set<string>([...readableStrings(emptyContainer), ...readableStrings(activeContainer)]);
    const seen = STATIC_KEYS.filter((key) => foundText(english, String(extensionsPanelsEn[key])));
    const unaccounted = STATIC_KEYS.filter(
      (key) => !seen.includes(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key),
    );
    assert.deepEqual(unaccounted, [], 'key neither rendered nor listed in NOT_RENDERED_IN_THIS_STATE');

    const stale = NOT_RENDERED_IN_THIS_STATE.filter((key) => seen.includes(key));
    assert.deepEqual(stale, [], 'key listed as not-rendered but is actually on screen in this render');
  });

  it('pluralizes and interpolates a representative sample under a live locale switch', async () => {
    registerLocale('fr-FR', {
      'extensionsPanels.privacyPanel.actionLogStats': '{events} événements · {kib} Kio (fr)',
      'extensionsPanels.privacyPanel.candidatePreferenceCount': {
        one: '{count} préférence candidate (fr)',
        other: '{count} préférences candidates (fr)',
      },
    } as Catalogue);
    setLocale('fr-FR');

    const host = new StubExtensionHost();
    host.actionLog.append({ intent: 'model.load', params: { schema: 'IFC4' } });
    const container = await mountActiveFlavorFixture(host);
    await revealProposals(container);

    assert.match(container.textContent ?? '', /1 événements · \d+,\d Kio \(fr\)/);
    assert.match(container.textContent ?? '', /1 préférence candidate \(fr\)/);
  });

  it('formats token and candidate-preference counts with the active locale, not raw JS numbers', async () => {
    registerLocale('ar-EG', {});
    setLocale('ar-EG');

    const host = new StubExtensionHost();
    const container = await mountActiveFlavorFixture(host);
    await revealProposals(container);

    // `overlayDraft` seeds from `flavorFixture('Existing overlay notes.')`
    // (23 chars -> Math.ceil(23 / 4) === 6 approx tokens) and the chat
    // fixture in `revealProposals` yields exactly one candidate preference.
    // Both interpolate a plain JS number into a translated message; per
    // `apps/viewer/src/i18n/README.md`, the display value must go through
    // `formatLocaleNumber`, not the raw number, so ar-EG renders
    // Arabic-Indic digits rather than ASCII ones.
    assert.match(container.textContent ?? '', /٦ approx tokens/);
    assert.doesNotMatch(container.textContent ?? '', /\b6 approx tokens\b/);
    assert.match(container.textContent ?? '', /١ candidate preference/);
    assert.doesNotMatch(container.textContent ?? '', /\b1 candidate preference/);
  });
});
