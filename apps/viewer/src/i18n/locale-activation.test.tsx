/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render';
import { MergeLayersBanner } from '@/components/viewer/MergeLayersBanner';
import { useViewerStore } from '@/store';
import {
  LOCALE_STORAGE_KEY,
  activateStartupLocale,
  createLocaleActivator,
  type CatalogueLoader,
  type LocaleEnvironment,
} from './locale-activation';
import { getLocale, resolve, setLocale, type Catalogue } from './registry';

const GERMAN: Catalogue = { 'mergeLayersBanner.reloadButton': 'Neu laden' };

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function environment(overrides: Partial<LocaleEnvironment> = {}): LocaleEnvironment {
  return { search: '', storage: memoryStorage(), languages: [], ...overrides };
}

let warnings: unknown[][] = [];
const originalWarn = console.warn;

beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  act(() => useViewerStore.setState({ mergeLayersPendingReload: true, mergeLayers: true }));
});

afterEach(() => {
  console.warn = originalWarn;
  cleanup();
  setLocale('en');
  act(() => useViewerStore.setState({ mergeLayersPendingReload: false, mergeLayers: false }));
});

function reloadLabel(container: HTMLElement): string | undefined {
  return [...container.querySelectorAll('button')].map((b) => b.textContent ?? '')
    .find((text) => text === 'Reload' || text === 'Neu laden');
}

describe('locale activation from contributed catalogues (#4785)', () => {
  it('stays English with no contributed locale, whatever the browser asks for', async () => {
    const html = { lang: 'en' };
    const active = await activateStartupLocale(
      createLocaleActivator({}, html),
      environment({ languages: ['de-CH', 'fr'] }),
    );
    assert.equal(active, 'en');
    assert.equal(html.lang, 'en');
  });

  it('loads the browser-preferred locale lazily and re-renders mounted UI in it', async () => {
    let loads = 0;
    const loaders: Record<string, CatalogueLoader> = {
      de: async () => { loads += 1; return GERMAN; },
      fr: async () => { throw new Error('fr must not load'); },
    };
    const html = { lang: 'en' };
    const container = render(<MergeLayersBanner />);
    assert.equal(reloadLabel(container), 'Reload');

    await act(async () => {
      await activateStartupLocale(createLocaleActivator(loaders, html), environment({ languages: ['de-AT', 'fr'] }));
    });
    assert.equal(loads, 1);
    assert.equal(getLocale(), 'de');
    assert.equal(html.lang, 'de');
    assert.equal(reloadLabel(container), 'Neu laden');
    // Keys the German file omits still render in English, not blank.
    assert.ok(container.textContent?.includes('Reload model to apply the new setting.'));
  });

  it('prefers ?lang= over the stored choice and browser languages, and remembers it', async () => {
    const storage = memoryStorage({ [LOCALE_STORAGE_KEY]: 'de' });
    const loaders = { de: async () => GERMAN, fr: async () => ({}) };
    const active = await activateStartupLocale(
      createLocaleActivator(loaders),
      environment({ search: '?lang=fr', storage, languages: ['de'] }),
    );
    assert.equal(active, 'fr');
    assert.equal(storage.values.get(LOCALE_STORAGE_KEY), 'fr');

    const next = await activateStartupLocale(
      createLocaleActivator(loaders),
      environment({ storage, languages: ['de'] }),
    );
    assert.equal(next, 'fr', 'the remembered choice outranks browser languages');
  });

  it('remembers an explicit ?lang=en so a German browser can opt back into English', async () => {
    const storage = memoryStorage();
    const loaders = { de: async () => GERMAN };
    await activateStartupLocale(createLocaleActivator(loaders), environment({ search: '?lang=en', storage, languages: ['de'] }));
    assert.equal(getLocale(), 'en');
    assert.equal(storage.values.get(LOCALE_STORAGE_KEY), 'en');
  });

  it('keeps English and warns when a locale fails to load or is not a catalogue', async () => {
    const html = { lang: 'en' };
    const broken = createLocaleActivator({
      de: async () => { throw new Error('chunk 404'); },
      fr: async () => undefined,
    }, html);
    assert.equal(await broken.activate(['de']), 'en');
    assert.equal(await broken.activate(['fr']), 'en');
    assert.equal(html.lang, 'en');
    assert.equal(warnings.length, 2);
  });

  it('applies the valid translations and lets a broken message fall back to English', async () => {
    const activator = createLocaleActivator({
      de: async () => ({ ...GERMAN, 'appearanceAssignmentList.assignmentAriaLabel': 'Zuweisung {index}' }),
    });
    assert.equal(await activator.activate(['de']), 'de');
    const message = String(warnings[0]?.[0]);
    assert.match(message, /unknown placeholder \{index\}/);
    assert.match(message, /missing placeholder \{sourceName\}/);
    assert.equal(resolve('mergeLayersBanner.reloadButton'), 'Neu laden');
    assert.equal(
      resolve('appearanceAssignmentList.assignmentAriaLabel', { position: 2, sourceName: 'Brick', modelName: 'North' }),
      'Assignment 2: Brick on North',
    );
  });

  it('lets the latest request win when an earlier catalogue resolves last', async () => {
    let releaseGerman: (catalogue: Catalogue) => void = () => {};
    const activator = createLocaleActivator({
      de: () => new Promise<Catalogue>((settle) => { releaseGerman = settle; }),
      fr: async () => ({ 'mergeLayersBanner.reloadButton': 'Recharger' }),
    });
    const slow = activator.activate(['de']);
    assert.equal(await activator.activate(['fr']), 'fr');
    releaseGerman(GERMAN);
    assert.equal(await slow, 'fr');
    assert.equal(getLocale(), 'fr');
  });

  it('ignores a contributed locales/en file instead of overriding the English fallback', () => {
    const activator = createLocaleActivator({ en: async () => ({}), de: async () => GERMAN });
    assert.deepEqual(activator.available, ['en', 'de']);
    assert.equal(warnings.length, 1);
  });
});
