/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CustomBasemapEditor`'s own chrome reads the i18n catalogue (#4918 slice:
 * cesiumgeo, `cesium-geo.en.ts`): the field labels/placeholders, the
 * third-party-privacy disclosure, and the save/remove controls. The
 * "Remove" button shares `cesiumGeo.shared.removeButton` with
 * `CustomTilesetEditor`, so it is asserted here too.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { CustomBasemapEditor } from './CustomBasemapEditor.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('cesiumGeo.basemap.') || key.startsWith('cesiumGeo.shared.')),
);
const KEYS = Object.keys(CATALOGUE) as (keyof typeof CATALOGUE)[];

function markValue(value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value as PluralTranslation)) {
    if (typeof text === 'string') marked[category] = `⟦${text}⟧`;
  }
  return marked as PluralTranslation;
}

const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, markValue(CATALOGUE[key]!)]));
const BASELINE_LOCALE = 'en';
const PSEUDO_LOCALE = 'custom-basemap-pseudo';

function readableStrings(root: ParentNode): Set<string> {
  const out = new Set<string>();
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === n.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

function assertAllTranslate(occurrences: Occurrence[], englishDom: Set<string>, afterDom: Set<string>): void {
  for (const occ of occurrences) {
    const english = resolve(occ.key as never, occ.params).trim();
    assert.ok(
      englishDom.has(english),
      `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`,
    );
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    for (const occ of occurrences) {
      const pseudo = resolve(occ.key as never, occ.params).trim();
      assert.ok(
        afterDom.has(pseudo),
        `${occ.key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`,
      );
    }
  } finally {
    act(() => setLocale(BASELINE_LOCALE));
  }
}

function domAfterPseudo(container: ParentNode): Set<string> {
  act(() => setLocale(PSEUDO_LOCALE));
  const set = readableStrings(container);
  act(() => setLocale(BASELINE_LOCALE));
  return set;
}

const originalState = useViewerStore.getState();

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({ cesiumCustomBasemap: null });
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState(originalState, true);
});

describe('CustomBasemapEditor localization (#4918)', () => {
  it('translates the field labels, placeholders, and privacy note with no basemap saved', () => {
    const container = render(<CustomBasemapEditor />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'cesiumGeo.basemap.urlLabel' },
        { key: 'cesiumGeo.basemap.urlPlaceholder' },
        { key: 'cesiumGeo.basemap.attributionLabel' },
        { key: 'cesiumGeo.basemap.attributionAriaLabel' },
        { key: 'cesiumGeo.basemap.attributionPlaceholder' },
        { key: 'cesiumGeo.basemap.attributionLinkLabel' },
        { key: 'cesiumGeo.basemap.attributionLinkPlaceholder' },
        { key: 'cesiumGeo.basemap.maxZoomLabel' },
        { key: 'cesiumGeo.basemap.maxZoomAriaLabel' },
        { key: 'cesiumGeo.basemap.privacyNote' },
        { key: 'cesiumGeo.basemap.saveButton' },
      ],
      englishDom,
      afterDom,
    );
    // No basemap saved yet: the shared Remove button must not render.
    assert.equal(container.querySelector('button')?.textContent, resolve('cesiumGeo.basemap.saveButton' as never));
  });

  it('translates the shared Remove button once a basemap is saved', () => {
    useViewerStore.setState({
      cesiumCustomBasemap: { protocol: 'xyz', url: 'https://tiles.example/{z}/{x}/{y}.png', credit: 'Example' },
    });
    const container = render(<CustomBasemapEditor />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate([{ key: 'cesiumGeo.shared.removeButton' }], englishDom, afterDom);
  });
});
