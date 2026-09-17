/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Startup wiring for contributed locales (#4785). Every `locales/<tag>.ts`
 * (default export: a `Catalogue`) becomes a lazy chunk, loaded only when the
 * negotiated locale needs it. Side-effect import from `main.tsx`; the logic
 * lives in `locale-activation.ts`, which the node test runner can load
 * (`import.meta.glob` is a Vite transform and cannot run there).
 */
import { activateStartupLocale, createLocaleActivator, type CatalogueLoader } from './locale-activation';

const modules = import.meta.glob<unknown>(['./locales/*.ts', '!./locales/*.test.ts'], { import: 'default' });

const loaders: Record<string, CatalogueLoader> = {};
for (const [path, load] of Object.entries(modules)) {
  const tag = path.slice('./locales/'.length, -'.ts'.length);
  loaders[tag] = load;
}

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch (error) {
    console.warn('[i18n] localStorage is unavailable; the locale choice will not be remembered.', error);
    return null;
  }
}

activateStartupLocale(createLocaleActivator(loaders, document.documentElement), {
  search: window.location.search,
  storage: localStorageOrNull(),
  languages: navigator.languages ?? [navigator.language],
}).catch((error: unknown) => {
  console.warn('[i18n] Locale startup failed; the viewer stays in English.', error);
});
