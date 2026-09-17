/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Locale negotiation (#4785): pick the best available catalogue for an
 * ordered list of requested BCP 47 tags (URL choice, stored choice, then
 * `navigator.languages`).
 *
 * For each requested tag, in order: an exact match (canonical,
 * case-insensitive), then progressively shorter prefixes (`zh-Hant-TW` →
 * `zh-Hant` → `zh`), then a regional sibling in the same script, then any
 * regional sibling (`de-CH` → `de-DE`). The first requested tag with any match wins, so a user whose
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

/** The script a tag implies (`zh-TW` → `Hant`), or '' when unknown. */
function likelyScript(tag: string): string {
  try {
    return new Intl.Locale(tag).maximize().script ?? '';
  } catch (error) {
    console.warn(`[i18n] Could not infer the script of "${tag}".`, error);
    return '';
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
    // Exact, then progressively truncated: zh-Hant-TW -> zh-Hant -> zh.
    const subtags = tag.toLowerCase().split('-');
    for (let length = subtags.length; length > 0; length -= 1) {
      const match = byCanonical.get(subtags.slice(0, length).join('-'));
      if (match) return match;
    }
    // A regional sibling, preferring one in the same writing system so a
    // zh-TW reader is not handed zh-Hans because it happened to be listed first.
    const language = subtags[0];
    const script = likelyScript(tag);
    const siblings = candidates.filter(({ canonical }) => languageOf(canonical) === language);
    const sameScript = siblings.find(({ canonical }) => likelyScript(canonical) === script);
    const sibling = sameScript ?? siblings[0];
    if (sibling) return sibling.locale;
  }
  return null;
}
