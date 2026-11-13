/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Locale activation (#4785): the runtime half of "a translator adds a file,
 * the viewer speaks it". `locales.boot.ts` discovers `locales/<tag>.ts` and
 * hands this module one lazy loader per file; nothing here knows which
 * locales exist, so adding one never touches viewer code.
 *
 * Selection order: the choice made in Settings → Language (remembered on this
 * browser), then `navigator.languages`, then English. A locale is loaded only
 * when selected, registered as an overlay on English (missing keys fall back
 * per key), and `<html lang>` follows the active locale so screen readers and
 * hyphenation pick the right language. There is no URL override (#9061).
 */
import { checkCatalogue, isCatalogueRecord } from './catalogue-problems';
import { negotiateLocale } from './negotiate-locale';
import { getLocale, registerLocale, setLocale, type Locale } from './registry';

export const LOCALE_STORAGE_KEY = 'ifc-lite:locale';

/** Module defaults are untrusted translator data until `checkCatalogue` accepts them. */
export type CatalogueLoader = () => Promise<unknown>;

export interface LocaleEnvironment {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  languages: readonly string[];
  /**
   * The locale a deploying host prefers (`ViewerRuntimeConfig.locale`). It is
   * only the initial default, while the user has made no choice in Settings:
   * Settings then shows it as the selected language, and Auto still means the
   * browser's languages, as its label says.
   */
  hostLocale?: string;
}

/**
 * Set when the user picks Auto while a host locale is set, so the host's
 * default does not come back on the next visit. Its own key, so
 * `LOCALE_STORAGE_KEY` only ever holds a BCP 47 tag. Like the locale key it
 * lives in `localStorage`, so it applies to the whole site (every viewer page
 * on this origin), not to one deployment's configuration. Without a host
 * locale Auto just forgets the choice, as before.
 */
export const LOCALE_AUTO_STORAGE_KEY = 'ifc-lite:locale-auto';

function readAutoChosen(storage: LocaleEnvironment['storage']): boolean {
  try {
    return storage?.getItem(LOCALE_AUTO_STORAGE_KEY) === '1';
  } catch (error) {
    console.warn('[i18n] Could not read the stored Auto choice.', error);
    return false;
  }
}

function writeAutoChosen(storage: LocaleEnvironment['storage'], auto: boolean): void {
  try {
    if (auto) storage?.setItem(LOCALE_AUTO_STORAGE_KEY, '1');
    else storage?.removeItem(LOCALE_AUTO_STORAGE_KEY);
  } catch (error) {
    console.warn('[i18n] Could not remember the Auto choice; it applies to this session only.', error);
  }
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
    console.warn('[i18n] Could not remember the chosen locale; it applies to this session only.', error);
  }
}

function forgetLocale(storage: LocaleEnvironment['storage']): void {
  try {
    storage?.removeItem(LOCALE_STORAGE_KEY);
  } catch (error) {
    console.warn('[i18n] Could not forget the stored locale.', error);
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

/** Pick the startup locale: the stored Settings choice, else the host's locale; then browser languages. */
export async function activateStartupLocale(
  activator: LocaleActivator,
  environment: LocaleEnvironment,
): Promise<Locale> {
  const stored = readStoredLocale(environment.storage);
  const head = stored !== null ? [stored] : readAutoChosen(environment.storage) ? [] : [environment.hostLocale];
  const requested = [...head, ...environment.languages]
    .filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '');
  return activator.activate(requested);
}

/** Settings → Language (#9061): an explicit choice, or Auto (browser languages). */
export interface LocaleChoice {
  /** English first, then every discovered locale. */
  readonly available: readonly Locale[];
  /** The chosen locale, or `null` for Auto. */
  chosen(): Locale | null;
  /** Remember `locale` on this browser and switch to it without a reload. Rejects,
   *  remembering nothing and restoring the previous choice, when it fails to load. */
  choose(locale: Locale): Promise<Locale>;
  /**
   * Auto: forget the choice and follow the browser languages, also over a
   * host locale (remembered under `LOCALE_AUTO_STORAGE_KEY` then).
   */
  clear(): Promise<Locale>;
}

export function createLocaleChoice(activator: LocaleActivator, environment: LocaleEnvironment): LocaleChoice {
  // Set once the user decides on this page, so a choice storage refused
  // still shows as chosen for the rest of the session.
  let session: { locale: Locale | null } | null = null;
  // The latest choose/clear owns storage and display; a slower earlier one only reports.
  let latest = 0;
  const chosen = (): Locale | null => {
    if (session) return session.locale;
    const stored = readStoredLocale(environment.storage);
    if (stored !== null) return negotiateLocale([stored], activator.available);
    if (readAutoChosen(environment.storage) || !environment.hostLocale) return null;
    // No choice yet, over a host locale: name what is actually active (the host
    // locale, or what applied when it failed to load), never claim Auto.
    return activator.available.includes(getLocale()) ? getLocale() : null;
  };
  return {
    available: activator.available,
    chosen,
    async choose(locale) {
      if (!activator.available.includes(locale)) throw new Error(`[i18n] Unknown locale "${locale}"`);
      const request = ++latest;
      const previous = chosen();
      const active = await activator.activate([locale]);
      if (request !== latest) return active;
      if (active !== locale) {
        // The catalogue failed to load and the activator fell back to English:
        // remember nothing, and put the previous choice back on screen.
        await activator.activate(previous === null ? environment.languages : [previous]);
        throw new Error(`[i18n] Could not load locale "${locale}"; the previous language is kept.`);
      }
      session = { locale };
      storeLocale(environment.storage, locale);
      writeAutoChosen(environment.storage, false);
      return active;
    },
    clear() {
      latest += 1;
      session = { locale: null };
      forgetLocale(environment.storage);
      writeAutoChosen(environment.storage, Boolean(environment.hostLocale));
      return activator.activate(environment.languages);
    },
  };
}

let installedChoice: LocaleChoice | null = null;

/** Called once by `startLocales` (`locales.boot.ts`); tests install their own. */
export function installLocaleChoice(choice: LocaleChoice | null): void {
  installedChoice = choice;
}

/** The running viewer's locale choice, or `null` before startup wiring ran. */
export function getLocaleChoice(): LocaleChoice | null {
  return installedChoice;
}
