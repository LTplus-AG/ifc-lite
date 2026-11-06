/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render';
import { MergeLayersBanner } from '@/components/viewer/MergeLayersBanner';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud';
import { useViewerStore } from '@/store';
import {
  LOCALE_STORAGE_KEY,
  activateStartupLocale,
  createLocaleActivator,
  type CatalogueLoader,
  type LocaleChoice,
  type LocaleEnvironment,
} from './locale-activation';
// Namespace import for the #9061 additions: with production reverted the file
// still loads and those tests fail on an assertion, not at import.
import * as activation from './locale-activation';
import { getLocale, resolve, setLocale, type Catalogue } from './registry';

const GERMAN: Catalogue = { 'mergeLayersBanner.reloadButton': 'Neu laden' };

function createLocaleChoice(...args: Parameters<typeof activation.createLocaleChoice>): LocaleChoice {
  const create: unknown = Reflect.get(activation, 'createLocaleChoice');
  assert.equal(typeof create, 'function', 'Settings → Language needs createLocaleChoice (#9061)');
  return activation.createLocaleChoice(...args);
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function environment(overrides: Partial<LocaleEnvironment> = {}): LocaleEnvironment {
  return { storage: memoryStorage(), languages: [], ...overrides };
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
    // The banner portals into ViewportHud's top-center region (#5504); mount
    // the HUD host alongside it, or HudItem renders nothing.
    const container = render(<><ViewportHud /><MergeLayersBanner /></>);
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

  it('#9061 Settings choice is stored, applies without a reload and outranks browser languages after one', async () => {
    const storage = memoryStorage();
    const loaders = { de: async () => GERMAN, fr: async () => ({}) };
    const html = { lang: 'en' };
    const container = render(<><ViewportHud /><MergeLayersBanner /></>);
    const choice = createLocaleChoice(createLocaleActivator(loaders, html), environment({ storage, languages: ['fr'] }));
    assert.equal(choice.chosen(), null, 'nothing stored reads as Auto');

    await act(async () => { await choice.choose('de'); });
    assert.equal(storage.values.get(LOCALE_STORAGE_KEY), 'de');
    assert.equal(choice.chosen(), 'de');
    assert.equal(getLocale(), 'de');
    assert.equal(html.lang, 'de');
    assert.equal(reloadLabel(container), 'Neu laden', 'mounted UI re-renders in the chosen locale');

    // "Reload": a fresh activator reads the stored choice before the browser's French.
    const next = await activateStartupLocale(createLocaleActivator(loaders), environment({ storage, languages: ['fr'] }));
    assert.equal(next, 'de');
  });

  it('#9061 Auto forgets the choice and negotiates the browser languages again', async () => {
    const storage = memoryStorage({ [LOCALE_STORAGE_KEY]: 'de' });
    const html = { lang: 'en' };
    const choice = createLocaleChoice(
      createLocaleActivator({ de: async () => GERMAN, fr: async () => ({}) }, html),
      environment({ storage, languages: ['fr-CA', 'de'] }),
    );
    assert.equal(choice.chosen(), 'de');
    assert.equal(await choice.clear(), 'fr');
    assert.equal(storage.values.has(LOCALE_STORAGE_KEY), false);
    assert.equal(choice.chosen(), null);
    assert.equal(html.lang, 'fr');
  });

  it('#9061 English can be chosen explicitly on a German browser', async () => {
    const storage = memoryStorage();
    const choice = createLocaleChoice(createLocaleActivator({ de: async () => GERMAN }), environment({ storage, languages: ['de'] }));
    assert.equal(await choice.choose('en'), 'en');
    assert.equal(storage.values.get(LOCALE_STORAGE_KEY), 'en');
    assert.equal(await activateStartupLocale(createLocaleActivator({ de: async () => GERMAN }), environment({ storage, languages: ['de'] })), 'en');
  });

  it('#9061 ?lang= in the address no longer affects the locale', async () => {
    // The URL is not an input any more: boot passed `location.search` through this field.
    // @ts-expect-error -- `search` was removed from LocaleEnvironment (#9061)
    environment({ search: '?lang=de' });
    const original = window.location.href;
    window.history.replaceState(null, '', '/?lang=de');
    try {
      const storage = memoryStorage();
      // What boot used to pass; an implementation that still reads it picks German.
      const withAddress = { ...environment({ storage, languages: ['en'] }), search: window.location.search };
      const active = await activateStartupLocale(createLocaleActivator({ de: async () => GERMAN }), withAddress);
      assert.equal(active, 'en');
      assert.equal(storage.values.has(LOCALE_STORAGE_KEY), false, 'nothing is pinned by a visit');
    } finally {
      window.history.replaceState(null, '', original);
    }
  });

  it('#9061 storage that throws keeps the viewer working and the choice for this session', async () => {
    const refusing = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    const activator = createLocaleActivator({ de: async () => GERMAN });
    assert.equal(await activateStartupLocale(activator, environment({ storage: refusing, languages: ['en'] })), 'en');
    const choice = createLocaleChoice(activator, environment({ storage: refusing, languages: ['en'] }));
    assert.equal(choice.chosen(), null);
    assert.equal(await choice.choose('de'), 'de');
    assert.equal(choice.chosen(), 'de', 'the session keeps the choice storage refused');
    assert.equal(await choice.clear(), 'en');
    assert.equal(choice.chosen(), null);
    assert.ok(warnings.length >= 3, 'each refused storage call is reported, not swallowed');
  });

  it('#9061 refuses a locale the viewer does not ship', async () => {
    const choice = createLocaleChoice(createLocaleActivator({ de: async () => GERMAN }), environment());
    await assert.rejects(choice.choose('xx'), /Unknown locale "xx"/);
    assert.equal(getLocale(), 'en');
  });

  it('#9075 review: a locale that fails to load is not remembered and the previous choice comes back', async () => {
    const storage = memoryStorage({ [LOCALE_STORAGE_KEY]: 'fr' });
    const html = { lang: 'en' };
    const activator = createLocaleActivator({
      fr: async () => ({ 'mergeLayersBanner.reloadButton': 'Recharger' }),
      de: async () => { throw new Error('chunk 404'); },
    }, html);
    const env = environment({ storage, languages: ['en'] });
    assert.equal(await activateStartupLocale(activator, env), 'fr');
    const choice = createLocaleChoice(activator, env);

    await assert.rejects(choice.choose('de'), /Could not load locale "de"/);
    assert.equal(storage.values.get(LOCALE_STORAGE_KEY), 'fr', 'the failed locale is not stored');
    assert.equal(choice.chosen(), 'fr', 'the displayed choice is the one that applies');
    assert.equal(getLocale(), 'fr', 'the previous language is back on screen, not an English fallback');
    assert.equal(html.lang, 'fr');
  });

  it('#9075 review: a slower earlier choice cannot overwrite a newer choice or Auto', async () => {
    let releaseGerman: (catalogue: Catalogue) => void = () => {};
    const loaders = {
      de: () => new Promise<Catalogue>((settle) => { releaseGerman = settle; }),
      fr: async () => ({}),
    };
    const storage = memoryStorage();
    const choice = createLocaleChoice(createLocaleActivator(loaders), environment({ storage, languages: ['en'] }));
    const slow = choice.choose('de');
    assert.equal(await choice.choose('fr'), 'fr');
    releaseGerman(GERMAN);
    await slow;
    assert.equal(storage.values.get(LOCALE_STORAGE_KEY), 'fr');
    assert.equal(choice.chosen(), 'fr');
    assert.equal(getLocale(), 'fr');

    const slowAgain = choice.choose('de');
    assert.equal(await choice.clear(), 'en');
    releaseGerman(GERMAN);
    await slowAgain;
    assert.equal(storage.values.has(LOCALE_STORAGE_KEY), false, 'Auto chosen last stays Auto');
    assert.equal(choice.chosen(), null);
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
