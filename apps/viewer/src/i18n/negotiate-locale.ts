/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Locale negotiation (#4785): pick the best available catalogue for an
 * ordered list of requested BCP 47 tags (URL choice, stored choice, then
 * `navigator.languages`).
 *
 * For each requested tag, in order: an exact match (case-insensitive), then
 * the bare language (`de-CH` → `de`), then a regional sibling (`de-CH` →
 * `de-DE`). The first requested tag with any match wins, so a user whose
 * browser lists `fr-CH, de` gets German only when no French catalogue exists.
 * Invalid tags are skipped, never thrown.
 */
import type { Locale } from './registry';

function canonicalize(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch (error) {
    console.warn(`[i18n] Ignoring invalid locale tag "${tag}".`, error);
    return null;
  }
}

function languageOf(tag: string): string {
  return tag.split('-')[0].toLowerCase();
}

export function negotiateLocale(
  requested: readonly string[],
  available: readonly Locale[],
): Locale | null {
  // Compare canonical forms (a `locales/iw.ts` file must answer a request
  // that canonicalizes to `he`), but return the tag as registered, since that
  // is the loader key.
  const candidates = available.flatMap((locale) => {
    const canonical = canonicalize(locale);
    return canonical ? [{ canonical: canonical.toLowerCase(), locale }] : [];
  });
  const byCanonical = new Map(candidates.map(({ canonical, locale }) => [canonical, locale]));
  for (const raw of requested) {
    const tag = raw.trim() === '' ? null : canonicalize(raw.trim());
    if (!tag) continue;
    const exact = byCanonical.get(tag.toLowerCase());
    if (exact) return exact;
    const language = languageOf(tag);
    const bare = byCanonical.get(language);
    if (bare) return bare;
    const sibling = candidates.find(({ canonical }) => languageOf(canonical) === language);
    if (sibling) return sibling.locale;
  }
  return null;
}
