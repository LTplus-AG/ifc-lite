/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registered-locale behaviour of the ribbon (#4785): interpolated counts,
 * per-key English fallback, and the switch notice.
 *
 * Deliberately imports nothing that this change added (only the ribbon and
 * the pre-existing `@/i18n` registry), and names catalogue keys as literals,
 * so a revert of the ribbon conversion still loads this file and fails on
 * its assertions instead of at import.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, mouseDown, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { TOOLBAR_STYLE_STORAGE_KEY } from '@/store/constants';
import { useViewerStore, type RibbonTabId } from '@/store';
import { RibbonToolbar } from './RibbonToolbar.js';

const TABS: RibbonTabId[] = ['file', 'home', 'view', 'elements', 'analyze', 'author'];

function showTab(container: HTMLElement, tab: RibbonTabId): void {
  const target = container.querySelectorAll('[role="tab"]')[TABS.indexOf(tab)];
  assert.ok(target, `tab ${tab} is rendered`);
  mouseDown(target, { button: 0 });
  assert.equal(useViewerStore.getState().ribbonTab, tab);
}

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

beforeEach(() => {
  window.localStorage.clear();
  setLocale('en');
  act(() => useViewerStore.setState({
    ribbonTab: 'home',
    ribbonCollapsed: false,
    selectedEntityId: 11,
    selectedEntityIds: new Set([11, 12, 13]),
  }));
});

afterEach(() => {
  cleanup();
  setLocale('en');
  window.localStorage.clear();
  act(() => useViewerStore.setState({ ribbonTab: 'home', selectedEntityId: null, selectedEntityIds: new Set() }));
});

describe('RibbonToolbar with a registered locale (#4785)', () => {
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
    const { basketViews, pinboardEntities } = useViewerStore.getState();
    const expected = `Präsentation (${basketViews.length} Ansichten, ${pinboardEntities.size} Elemente)`;
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
    // Only a visitor from before the ribbon gets the notice (#5840).
    window.localStorage.setItem('ifc-lite:ribbon-notice-audience', 'returning');
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
