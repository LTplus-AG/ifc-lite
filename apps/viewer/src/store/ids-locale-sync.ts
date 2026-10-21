/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SupportedLocale } from '@ifc-lite/ids';
import type { StoreApi } from 'zustand';
import { getLocale, subscribeLocale } from '../i18n/registry';
import type { ViewerState } from './index.js';

function idsLocale(locale: string): SupportedLocale {
  const language = locale.split('-')[0].toLowerCase();
  return language === 'de' || language === 'fr' || language === 'it' || language === 'ru'
    ? language
    : 'en';
}

/** Keep IDS checks and authoring on the active Viewer language, including async startup. */
export function registerIdsLocaleSync(store: Pick<StoreApi<ViewerState>, 'getState'>): () => void {
  let viewerLocale = getLocale();
  store.getState().setIdsLocale(idsLocale(viewerLocale));

  return subscribeLocale(() => {
    const next = getLocale();
    // Lazy catalogue registration also notifies; it does not change the chosen language.
    if (next === viewerLocale) return;
    viewerLocale = next;
    store.getState().setIdsLocale(idsLocale(next));
  });
}
