/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The default toolbar's chrome reads the i18n catalogue (#4785).
 *
 * The oracle is a pseudo-locale that maps every `ribbon.*` key to a marked
 * copy of its English text. Every tab is rendered in English, the locale is
 * switched live, and every English ribbon string that was on screen (visible
 * text, aria-label, group label) must be gone and replaced by its marked copy.
 * A label left hardcoded, or a consumer that does not re-render on a locale
 * switch, fails here by name.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { ribbonToolbarEn } from '@/i18n/catalogues/ribbon-toolbar.en';
import { TOOLBAR_STYLE_STORAGE_KEY } from '@/store/constants';
import { useViewerStore, type RibbonTabId } from '@/store';
import { RibbonToolbar } from './RibbonToolbar.js';

const TABS: RibbonTabId[] = ['file', 'home', 'view', 'elements', 'analyze', 'author'];
type RibbonKey = keyof typeof ribbonToolbarEn;
const RIBBON_KEYS = Object.keys(ribbonToolbarEn) as RibbonKey[];

/**
 * Keys a tab owns: its own namespace plus the always-visible strip and notice.
 * Shared registries (camera commands, exporters) render some identical English
 * text on other tabs — "Home" is both a Home-tab button and a camera command —
 * and those registry strings are not this catalogue's to translate.
 */
function ownedBy(tab: RibbonTabId, key: RibbonKey): boolean {
  const scope = key.split('.')[1];
  return scope === tab || !TABS.some((name) => name === scope);
}

/** Marked copy that keeps every `{placeholder}` intact. */
const mark = (text: string) => `⟦${text}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(RIBBON_KEYS.map((key) => [key, mark(ribbonToolbarEn[key])]));

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));
}

/** Every string a user or assistive technology can read in the ribbon. */
function readableStrings(root: HTMLElement): Set<string> {
  const out = new Set<string>();
  for (const element of root.querySelectorAll('*')) {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  }
  return out;
}

function showTab(container: HTMLElement, tab: RibbonTabId): void {
  const tabs = [...container.querySelectorAll('[role="tab"]')];
  const target = tabs[TABS.indexOf(tab)];
  assert.ok(target, `tab ${tab} is rendered`);
  click(target);
  assert.equal(useViewerStore.getState().ribbonTab, tab);
}

beforeEach(() => {
  window.localStorage.clear();
  setLocale('en');
  act(() => useViewerStore.setState({
    ribbonTab: 'home',
    ribbonCollapsed: false,
    selectedEntityId: 11,
    selectedEntityIds: new Set([11, 12, 13]),
    cesiumAvailable: true,
    cesiumEnabled: true,
    cesiumPlacementEditMode: false,
  }));
});

afterEach(() => {
  cleanup();
  setLocale('en');
  window.localStorage.clear();
  act(() => useViewerStore.setState({
    ribbonTab: 'home', selectedEntityId: null, selectedEntityIds: new Set(),
    cesiumAvailable: false, cesiumEnabled: false,
  }));
});

describe('RibbonToolbar localization (#4785)', () => {
  it('replaces every rendered English ribbon string when the locale switches live', () => {
    const container = render(<RibbonToolbar />);
    registerLocale('ribbon-pseudo', PSEUDO);
    const english = new Map<RibbonTabId, Set<string>>();
    for (const tab of TABS) {
      showTab(container, tab);
      english.set(tab, readableStrings(container));
    }

    act(() => setLocale('ribbon-pseudo'));
    const covered = new Set<RibbonKey>();
    for (const tab of TABS) {
      showTab(container, tab);
      const localized = readableStrings(container);
      for (const key of RIBBON_KEYS) {
        const text = ribbonToolbarEn[key];
        if (!ownedBy(tab, key) || text.includes('{') || !english.get(tab)?.has(text)) continue;
        covered.add(key);
        assert.ok(localized.has(mark(text)), `${tab}: ${key} renders its translation`);
      }
      for (const text of localized) {
        const leftover = RIBBON_KEYS.find((key) => ownedBy(tab, key) && ribbonToolbarEn[key] === text);
        assert.equal(leftover, undefined, `${tab}: "${text}" is still hardcoded English`);
      }
    }
    // The oracle must actually have looked at the ribbon, not at nothing.
    assert.ok(covered.size >= 100, `expected >= 100 ribbon strings on screen, saw ${covered.size}`);
  });

  it('interpolates live counts into translated labels and tooltips', () => {
    registerLocale('ribbon-counts', {
      'ribbon.elements.selectionGroupCount': 'Auswahl · {count}',
      'ribbon.view.presentTooltip': 'Präsentation ({views} Ansichten, {entities} Elemente)',
      'ribbon.bandAriaLabel': 'Befehle: {tab}',
      'ribbon.tab.elements': 'Elemente',
    });
    setLocale('ribbon-counts');
    const container = render(<RibbonToolbar />);

    showTab(container, 'elements');
    assert.ok(container.querySelector('[role="group"][aria-label="Auswahl · 3"]'), 'selection count group');
    assert.ok(container.querySelector('[role="tabpanel"][aria-label="Befehle: Elemente"]'), 'band label');

    showTab(container, 'view');
    const expected = interpolate('Präsentation ({views} Ansichten, {entities} Elemente)', {
      views: useViewerStore.getState().basketViews.length,
      entities: useViewerStore.getState().pinboardEntities.size,
    });
    assert.ok(container.querySelector(`button[aria-label="${expected}"]`), 'present tooltip');
  });

  it('falls back to English per key for a partial locale', () => {
    registerLocale('ribbon-partial', { 'ribbon.tab.home': 'Start', 'ribbon.home.measure': 'Messen' });
    setLocale('ribbon-partial');
    const container = render(<RibbonToolbar />);
    showTab(container, 'home');
    const strings = readableStrings(container);
    assert.ok(strings.has('Start'));
    assert.ok(strings.has('Messen'));
    assert.ok(strings.has('Walk'), 'untranslated key renders in English');
    assert.ok(strings.has('Measure & Mark'), 'untranslated group renders in English');
  });

  it('localizes the one-time ribbon switch notice', () => {
    window.localStorage.removeItem(TOOLBAR_STYLE_STORAGE_KEY);
    registerLocale('ribbon-notice', {
      'ribbon.notice.keepClassic': 'Klassische Leiste behalten',
      'ribbon.notice.dismissAriaLabel': 'Hinweis schließen',
    });
    setLocale('ribbon-notice');
    const container = render(<RibbonToolbar />);
    const buttons = [...container.querySelectorAll('button')];
    assert.ok(buttons.some((button) => button.textContent === 'Klassische Leiste behalten'));
    assert.ok(container.querySelector('button[aria-label="Hinweis schließen"]'));
  });
});
