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
import { advance, cleanup, mouseDown, press, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { ribbonToolbarEn } from '@/i18n/catalogues/ribbon-toolbar.en';
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

/**
 * Static keys this render cannot show, each for a stated reason. Everything
 * else in the catalogue must land on its control.
 */
const NOT_RENDERED_IN_THIS_STATE: RibbonKey[] = [
  'ribbon.themeTooltip', // Radix tooltip content, only mounted on hover
  'ribbon.infoTooltip', // Radix tooltip content, only mounted on hover
  'ribbon.expand', // ribbon is expanded
  'ribbon.file.refreshModelsTooltip', // no models loaded
  'ribbon.file.shareGroup', // collab feature flag is off under test
  'ribbon.file.share',
  'ribbon.file.shareTooltip',
  'ribbon.file.room',
  'ribbon.file.roomTooltip',
  'ribbon.file.roomNotJoinedTooltip',
  'ribbon.view.worldShowTooltip', // Cesium is enabled
  'ribbon.view.moveGeorefStopTooltip', // not in placement mode
  'ribbon.elements.selectionGroup', // a selection exists
  'ribbon.elements.hideShortcut', // shortcut shows only in tooltip content
  'ribbon.analyze.appsGroup', // no analysis extensions installed
  'ribbon.author.exitEditTooltip', // edit mode is off
  'ribbon.author.editLockedTooltip', // single-user session can edit
];

/** Key-specific pseudo translation; keeps every `{placeholder}` of the English text. */
const mark = (key: RibbonKey) => `⟦${key}|${ribbonToolbarEn[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(RIBBON_KEYS.map((key) => [key, mark(key)]));
const MARKED = /^⟦(ribbon\.[^|]+)\|/;

/**
 * Every string a user or assistive technology can read, keyed by its slot
 * (element position + aria-label or own text). The DOM shape of a tab does not
 * change with the locale, so the same slot before and after a switch is the
 * same control.
 */
function readableSlots(root: HTMLElement): Map<string, string> {
  const out = new Map<string, string>();
  root.querySelectorAll('*').forEach((element, index) => {
    const label = element.getAttribute('aria-label');
    if (label) out.set(`${index}:aria`, label);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.set(`${index}:text`, ownText);
  });
  return out;
}

function showTab(container: HTMLElement, tab: RibbonTabId): void {
  const tabs = [...container.querySelectorAll('[role="tab"]')];
  const target = tabs[TABS.indexOf(tab)];
  assert.ok(target, `tab ${tab} is rendered`);
  mouseDown(target);
  assert.equal(useViewerStore.getState().ribbonTab, tab);
}

beforeEach(() => {
  window.localStorage.clear();
  // The switch notice only renders for a visitor who used the viewer before
  // the ribbon (#5840); mark this browser as one so its strings are covered.
  window.localStorage.setItem('ifc-lite:ribbon-notice-audience', 'returning');
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
  it('#5815 ArrowRight selects View and labels the command band', async () => {
    const container = render(<RibbonToolbar />);
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    assert.equal(tabs.length, TABS.length);
    tabs[1].focus(); // Home is the initial tab.
    press(tabs[1], 'ArrowRight');
    await advance(5);
    assert.equal(useViewerStore.getState().ribbonTab, 'view');
    assert.equal(document.activeElement, tabs[2]);
    const panel = container.querySelector('[role="tabpanel"]');
    assert.ok(panel);
    assert.equal(panel.getAttribute('aria-labelledby'), tabs[2].id);
  });

  it('puts each key translation on the control that showed its English, on every tab', () => {
    const container = render(<RibbonToolbar />);
    registerLocale('ribbon-pseudo', PSEUDO);
    const english = new Map<RibbonTabId, Map<string, string>>();
    for (const tab of TABS) {
      showTab(container, tab);
      english.set(tab, readableSlots(container));
    }

    act(() => setLocale('ribbon-pseudo'));
    const covered = new Set<RibbonKey>();
    for (const tab of TABS) {
      showTab(container, tab);
      const before = english.get(tab) ?? new Map<string, string>();
      const after = readableSlots(container);
      assert.equal(after.size, before.size, `${tab}: same readable slots in both locales`);
      for (const [slot, text] of before) {
        const shown = after.get(slot) ?? '';
        // Owned keys whose English is exactly this text (placeholder keys are
        // interpolated, so they are checked by the literal-catalogue tests).
        const candidates = RIBBON_KEYS.filter((key) =>
          ownedBy(tab, key) && !ribbonToolbarEn[key].includes('{') && ribbonToolbarEn[key] === text);
        if (candidates.length > 0) {
          const match = candidates.find((key) => shown === mark(key));
          assert.ok(match, `${tab}: "${text}" at ${slot} should be translated, shows "${shown}"`);
          covered.add(match);
        }
        const markedKey = MARKED.exec(shown)?.[1];
        if (markedKey && !shown.includes('{') && Object.hasOwn(ribbonToolbarEn, markedKey)) {
          const expected = ribbonToolbarEn[markedKey as RibbonKey];
          if (!expected.includes('{')) {
            assert.equal(text, expected, `${tab}: ${markedKey} rendered on the control that showed "${text}"`);
          }
        }
      }
    }
    // Independent of what rendered: every static key in the catalogue must have
    // shown up on its own control, unless listed as not reachable in this state.
    // A key wired to the wrong control leaves the right key unrendered here.
    const missing = RIBBON_KEYS.filter((key) => !ribbonToolbarEn[key].includes('{') && !covered.has(key));
    assert.deepEqual(missing, NOT_RENDERED_IN_THIS_STATE);
  });
});
