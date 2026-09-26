/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PropertiesPanel.tsx`'s OWN chrome — as opposed to the extracted card
 * components `properties/Properties.i18n.test.tsx` already covers — reads
 * the `properties.panel.*` keys added to the existing `properties.en.ts`
 * catalogue (#4918 slice: panel outer chrome; see that file's own
 * docblock for the exact surface). This suite renders the panel with the
 * default (no model, no selection) store state, which exercises the
 * empty-state chrome: the "Inspector" header and the no-selection prompt.
 * The entity-header, tabs, and collapsible-section chrome need a loaded
 * model and a real selection to render and are left to manual
 * verification, same reasoning `properties/Properties.i18n.test.tsx`
 * gives for cards it cannot mount standalone.
 *
 * Static import, no revert-oracle guard: `properties.en.ts` already
 * existed before this slice (#4918 slice 4), so reverting this slice's
 * production change removes only the `properties.panel.*` ROWS, not the
 * module — a missing key resolves to `undefined` and the
 * `typeof value === 'string'` assertion below fails on its own merits,
 * per the #4918 revert-oracle lesson against `describe.skip`.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import { propertiesPanelEn as propertiesEn } from '@/i18n/catalogues/properties-panel.en';
import { useViewerStore } from '@/store';
import { PropertiesPanel } from './PropertiesPanel.js';

type PropertiesKey = keyof typeof propertiesEn;

function markValue(key: string, value: TranslationValue | undefined): TranslationValue {
  if (typeof value !== 'string') return `⟦${key}|MISSING⟧`;
  return `⟦${key}|${value}⟧`;
}
const PANEL_KEYS = (Object.keys(propertiesEn) as PropertiesKey[]).filter((key) => key.startsWith('properties.panel.'));
const PSEUDO: Catalogue = Object.fromEntries(
  PANEL_KEYS.map((key) => [key, markValue(key, propertiesEn[key])]),
);
const PSEUDO_LOCALE = 'properties-panel-pseudo';

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
    selectedEntityId: null,
    selectedEntity: null,
    selectedEntities: [],
    selectedModelId: null,
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('PropertiesPanel outer-chrome localization (#4918)', () => {
  it('translates the empty-state header, title, and no-selection hint', () => {
    render(<PropertiesPanel />);
    const english = readable();
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readable();
    act(() => setLocale('en'));

    const keys: PropertiesKey[] = [
      'properties.panel.title',
      'properties.panel.emptyTitle',
      'properties.panel.emptyHintSingleModel',
    ];
    for (const key of keys) {
      const text = propertiesEn[key] as string;
      assert.equal(typeof text, 'string');
      assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
      assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
    }
  });
});
