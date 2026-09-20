/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The unified sidebar's activity bar reads the i18n catalogue (#4918 slice:
 * shell/sidebar chrome, `shell-chrome.en.ts`'s `shellChrome.activityBar.*`
 * and shared `shellChrome.shared.*` keys).
 *
 * Same oracle shape as `MainToolbar.i18n.test.tsx`: a pseudo-locale marks
 * every static (non-interpolated) key with `⟦key|…⟧`, the bar is rendered in
 * two states (normal and customize mode) to surface as much of its own
 * chrome as possible, the locale is switched live, and every marked string
 * that was readable in English must reappear marked. Two DOM passes, same
 * reasoning as `MainToolbar.i18n.test.tsx`: focusing a button opens its
 * Radix `TooltipContent` synchronously (CHROME pass); the overflow menu only
 * mounts its body once opened via the pointerdown+click pair Radix's
 * uncontrolled trigger needs (MENU pass).
 *
 * Interpolated keys (`{title}`, `{count}`, `{key}`) are checked with exact
 * expected text instead of the generic static-key sweep. `altShortcutHint` /
 * `floatingHint` / `poppedHint` are not exercised here: they need a panel
 * floated or popped out (`floatingPanels/poppedOutIds` store wiring), an
 * edge state out of scope for this chrome oracle.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { shellChromeEn } from '@/i18n/catalogues/shell-chrome.en';
import { useViewerStore } from '@/store';
import { ActivityBar } from './ActivityBar.js';

type ShellChromeKey = keyof typeof shellChromeEn;
const RELEVANT_KEYS = (Object.keys(shellChromeEn) as ShellChromeKey[]).filter(
  (key) => key.startsWith('shellChrome.activityBar.') || key.startsWith('shellChrome.shared.'),
);
const STATIC_KEYS = RELEVANT_KEYS.filter((key) => {
  const value = shellChromeEn[key];
  return typeof value === 'string' && !value.includes('{');
});

const mark = (key: ShellChromeKey) => `⟦${key}|${shellChromeEn[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(RELEVANT_KEYS.map((key) => [key, mark(key)]));

/** Dispatch the pointerdown+click pair Radix's uncontrolled DropdownMenu
 *  trigger needs to open — a plain `click` does not toggle it (#4918). */
function openMenu(trigger: Element): void {
  act(() => {
    trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  act(() => {
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** aria-labels, plain text, and (by focusing each button in turn) every
 *  reachable Radix `TooltipContent` string. The overflow menu must stay
 *  closed here — see `menuStrings` for that pass. */
function chromeStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const button of container.querySelectorAll('button')) {
    act(() => button.focus());
    addReadable(document.body, out);
    act(() => button.blur());
  }
  return out;
}

const RESET = {
  sidebarMode: 'expanded' as const,
  sidebarHiddenIds: [],
  sidebarCustomizing: false,
};

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(RESET);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

describe('ActivityBar localization (#4918)', () => {
  it('translates the always-visible rail chrome (aria-labels + tooltips)', () => {
    const container = render(<ActivityBar />);
    const english = chromeStrings(container);

    registerLocale('activity-bar-chrome-pseudo', PSEUDO);
    act(() => setLocale('activity-bar-chrome-pseudo'));
    const after = chromeStrings(container);

    let coveredAny = false;
    for (const key of STATIC_KEYS) {
      const text = shellChromeEn[key];
      if (typeof text !== 'string' || !english.has(text)) continue;
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      coveredAny = true;
    }
    assert.ok(coveredAny, 'expected at least one static activityBar key to be visible in the default render');
  });

  it('translates the overflow ("Sidebar options") menu body', () => {
    useViewerStore.setState({ sidebarHiddenIds: ['zones'] });
    const container = render(<ActivityBar />);

    const trigger = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === shellChromeEn['shellChrome.activityBar.sidebarOptions'],
    );
    assert.ok(trigger, 'expected the "Sidebar options" trigger button');
    openMenu(trigger!);

    const english = new Set<string>();
    addReadable(document.body, english);
    assert.ok(english.has('Show all panels (1 hidden)'), 'expected the interpolated hidden-count menu item');

    registerLocale('activity-bar-menu-pseudo', PSEUDO);
    act(() => setLocale('activity-bar-menu-pseudo'));
    const after = new Set<string>();
    addReadable(document.body, after);

    for (const key of [
      'shellChrome.activityBar.customizePanelsMenuItem',
      'shellChrome.activityBar.resetLayoutMenuItem',
      'shellChrome.activityBar.floatCurrentPanel',
      'shellChrome.activityBar.popOutToAnotherScreen',
    ] as ShellChromeKey[]) {
      assert.ok(after.has(mark(key)), `${key}: menu item must be translated`);
    }
    const marked = mark('shellChrome.activityBar.showAllPanels' as ShellChromeKey).replace('{count}', '1');
    assert.ok([...after].some((s) => s.includes(marked)), `expected the marked+interpolated hidden-count menu item, got: ${[...after].join(' | ')}`);
  });

  it('translates the customize-mode chrome (iconAriaLabelHide, doneCustomizing, clickToHideHint)', () => {
    useViewerStore.setState({ sidebarCustomizing: true });
    const container = render(<ActivityBar />);

    const toggle = container.querySelector('[data-sidebar-customize-toggle]');
    assert.ok(toggle, 'expected the customize toggle button');
    assert.equal(toggle!.getAttribute('aria-label'), 'Done customizing');

    // Any rail icon's aria-label should read "{title}, activate to hide from the sidebar".
    const hideButton = container.querySelector<HTMLButtonElement>('button[aria-label$="activate to hide from the sidebar"]');
    assert.ok(hideButton, 'expected at least one rail icon in "activate to hide" aria-label form');

    registerLocale('activity-bar-customize-pseudo', PSEUDO);
    act(() => setLocale('activity-bar-customize-pseudo'));

    assert.equal(toggle!.getAttribute('aria-label'), mark('shellChrome.shared.doneCustomizing' as ShellChromeKey));

    act(() => hideButton!.focus());
    const after = new Set<string>();
    addReadable(document.body, after);
    act(() => hideButton!.blur());
    const expectedHideSuffix = mark('shellChrome.activityBar.iconAriaLabelHide' as ShellChromeKey)
      .replace('{title}', '')
      .replace(/^⟦shellChrome\.activityBar\.iconAriaLabelHide\|/, '');
    assert.ok(
      [...after].some((s) => s.endsWith(expectedHideSuffix)),
      `expected a marked "activate to hide" aria-label, got: ${[...after].join(' | ')}`,
    );
    assert.ok(
      [...after].some((s) => s.includes(mark('shellChrome.activityBar.clickToHideHint' as ShellChromeKey))),
      'expected the marked click-to-hide tooltip hint',
    );
  });
});
