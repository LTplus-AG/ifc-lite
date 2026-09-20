/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HierarchyPanel.tsx`'s OWN chrome — the panel shell around the tree/node
 * rows `hierarchy/Hierarchy.i18n.test.tsx` already covers — reads the
 * `hierarchy.panel.*` keys added to the existing `hierarchy.en.ts`
 * catalogue (#4918 slice: panel outer chrome; see that file's own
 * docblock for the exact surface). This suite renders the panel with the
 * default (no model) store state, which exercises the loading/no-model
 * empty-state chrome. The search field, grouping tabs, section headers,
 * and footer filter chips need a loaded model (and, for the filter chips,
 * an active filter) to render and are left to manual verification, same
 * reasoning `properties/Properties.i18n.test.tsx` gives for cards it
 * cannot mount standalone.
 *
 * Static import, no revert-oracle guard: `hierarchy.en.ts` already existed
 * before this slice (#4918 slice 4), so reverting this slice's production
 * change removes only the `hierarchy.panel.*` ROWS, not the module — a
 * missing key resolves to `undefined` and the `typeof value === 'string'`
 * assertion below fails on its own merits, per the #4918 revert-oracle
 * lesson against `describe.skip`.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import { hierarchyEn } from '@/i18n/catalogues/hierarchy.en';
import { useViewerStore } from '@/store';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { HierarchyPanel } from './HierarchyPanel.js';

type HierarchyKey = keyof typeof hierarchyEn;

function markValue(key: string, value: TranslationValue | undefined): TranslationValue {
  if (typeof value !== 'string') return `⟦${key}|MISSING⟧`;
  return `⟦${key}|${value}⟧`;
}
const PANEL_KEYS = (Object.keys(hierarchyEn) as HierarchyKey[]).filter((key) => key.startsWith('hierarchy.panel.'));
const PSEUDO: Catalogue = Object.fromEntries(
  PANEL_KEYS.map((key) => [key, markValue(key, hierarchyEn[key])]),
);
const PSEUDO_LOCALE = 'hierarchy-panel-pseudo';

function readable(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState({
    ifcDataStore: null,
    geometryResult: null,
    models: new Map(),
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('HierarchyPanel outer-chrome localization (#4918)', () => {
  it('translates the no-model empty-state header and hint', () => {
    render(
      <SourceHostProvider>
        <HierarchyPanel />
      </SourceHostProvider>,
    );
    const english = readable();
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readable();
    act(() => setLocale('en'));

    const keys: HierarchyKey[] = [
      'hierarchy.panel.title',
      'hierarchy.panel.noModelTitle',
      'hierarchy.panel.noModelHint',
    ];
    for (const key of keys) {
      const text = hierarchyEn[key] as string;
      assert.equal(typeof text, 'string');
      assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
      assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
    }
  });
});
