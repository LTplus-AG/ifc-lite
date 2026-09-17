/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Locale activation (#4785): the runtime half of "a translator adds a file,
 * the viewer speaks it". `locales.boot.ts` discovers `locales/<tag>.ts` and
 * hands this module one lazy loader per file; nothing here knows which
 * locales exist, so adding one never touches viewer code.
 *
 * Selection order: `?lang=<tag>` (remembered on this browser), then the
 * remembered choice, then `navigator.languages`, then English. A locale is
 * loaded only when selected, registered as an overlay on English (missing
 * keys fall back per key), and `<html lang>` follows the active locale so
 * screen readers and hyphenation pick the right language.
 */
import { checkCatalogue, isCatalogueRecord } from './catalogue-problems';
import { negotiateLocale } from './negotiate-locale';
import { getLocale, registerLocale, setLocale, type Locale } from './registry';

export const LOCALE_QUERY_PARAM = 'lang';
export const LOCALE_STORAGE_KEY = 'ifc-lite:locale';

/** Module defaults are untrusted translator data until `checkCatalogue` accepts them. */
export type CatalogueLoader = () => Promise<unknown>;

export interface LocaleEnvironment {
  /** `location.search`, e.g. `?lang=de`. */
  search: string;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  languages: readonly string[];
}

function readStoredLocale(storage: LocaleEnvironment['storage']): string | null {
  try {
    return storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch (error) {
    console.warn('[i18n] Could not read the stored locale; using browser languages.', error);
    return null;
  }
}

function storeLocale(storage: LocaleEnvironment['storage'], locale: Locale): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch (error) {
    console.warn('[i18n] Could not remember the chosen locale.', error);
  }
}

export interface LocaleActivator {
  /** English first, then every discovered locale. */
  readonly available: readonly Locale[];
  /** Negotiate, load, register and switch. Resolves to the locale now active. */
  activate(requested: readonly string[]): Promise<Locale>;
}

export function createLocaleActivator(
  loaders: Readonly<Record<Locale, CatalogueLoader>>,
  documentElement: { lang: string } | null = null,
): LocaleActivator {
  const discovered = Object.keys(loaders).filter((tag) => {
    if (tag.toLowerCase() !== 'en') return true;
    console.warn('[i18n] Ignoring locales/en: English is the in-tree catalogue and cannot be overridden.');
    return false;
  });
  const available = ['en', ...discovered];
  let latestRequest = 0;

  const apply = (locale: Locale): Locale => {
    setLocale(locale);
    if (documentElement) documentElement.lang = getLocale();
    return getLocale();
  };

  return {
    available,
    async activate(requested) {
      const request = ++latestRequest;
      const match = negotiateLocale(requested, available) ?? 'en';
      if (match === 'en') return apply('en');

      let catalogue: unknown;
      try {
        catalogue = await loaders[match]();
      } catch (error) {
        console.warn(`[i18n] Could not load locale "${match}"; keeping English.`, error);
        return request === latestRequest ? apply('en') : getLocale();
      }
      // A newer request superseded this one while the catalogue loaded.
      if (request !== latestRequest) return getLocale();
      if (!isCatalogueRecord(catalogue)) {
        console.warn(`[i18n] locales/${match} has no default-exported catalogue object; keeping English.`);
        return apply('en');
      }
      const checked = checkCatalogue(catalogue);
      if (checked.problems.length > 0) {
        const count = checked.problems.length;
        console.warn(`[i18n] locales/${match}: ${count} problem(s), affected messages fall back to English:\n${checked.problems.join('\n')}`);
      }
      registerLocale(match, checked.catalogue);
      return apply(match);
    },
  };
}

/**
 * Pick the startup locale from the environment. An explicit `?lang=` choice
 * is remembered, so a shared link or a one-time switch sticks across reloads.
 */
export async function activateStartupLocale(
  activator: LocaleActivator,
  environment: LocaleEnvironment,
): Promise<Locale> {
  const fromQuery = new URLSearchParams(environment.search).get(LOCALE_QUERY_PARAM);
  const requested = [fromQuery, readStoredLocale(environment.storage), ...environment.languages]
    .filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '');
  const active = await activator.activate(requested);
  if (fromQuery !== null && negotiateLocale([fromQuery], activator.available) === active) {
    storeLocale(environment.storage, active);
  }
  return active;
}
