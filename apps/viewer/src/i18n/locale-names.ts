/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Locale } from './registry';

/**
 * A locale's name in its own language ("English", "Русский"), so a reader
 * stuck in a UI they cannot read still finds theirs (#9061). Falls back to
 * the tag when the runtime has no display names for it.
 */
export function localeDisplayName(locale: Locale): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale);
    if (name && name !== locale) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch (error) {
    console.warn(`[i18n] No display name for locale "${locale}".`, error);
  }
  return locale;
}
