/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StandardFontLedger } from '../document/standard-font-text';
import { isReportLanguage, type ReportLanguage } from './report-language';
import { en, type ReportMessages } from './report-locales/en';
import { de } from './report-locales/de';
import { fr } from './report-locales/fr';
import { it } from './report-locales/it';
import { es } from './report-locales/es';
import { nl } from './report-locales/nl';
import { pt } from './report-locales/pt';
import { da } from './report-locales/da';
import { sv } from './report-locales/sv';
import { nb } from './report-locales/nb';
import { fi } from './report-locales/fi';
import { pl } from './report-locales/pl';
import { cs } from './report-locales/cs';

// #7302: report language belongs to the saved report, independently of UI locale.
// Each offered language supplies every key; no implicit English fallback.
export const REPORT_MESSAGES: Record<ReportLanguage, ReportMessages> = { en, de, fr, it, es, nl, pt, da, sv, nb, fi, pl, cs };
export type ReportText = (key: keyof ReportMessages, values?: Readonly<Record<string, string | number>>) => string;

/** Interpolate the catalogue once. Captured values are literal, never parsed as another template. */
export function reportTextFor(language: string): ReportText {
  if (!isReportLanguage(language)) throw new Error(`Unsupported native report chrome language: ${language}`);
  return (key, values = {}) => REPORT_MESSAGES[language][key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Missing report message value ${key}.${name}`);
    return String(value);
  });
}

/** Reuse the native font ledger's actual substitutions without changing its shared exporter policy. */
export function reportFontNotice(ledger: StandardFontLedger, text: ReportText): string | null {
  const code = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
  const parts: string[] = [];
  if (ledger.transliterated.size) parts.push(text('fontTransliterated', { values: [...ledger.transliterated]
    .map(([char, value]) => text('fontAs', { code: code(char), value })).join(', ') }));
  if (ledger.replaced.size) parts.push(text('fontReplaced', { values: [...ledger.replaced]
    .map(([char, count]) => `${code(char)} (${count}x)`).join(', ') }));
  return parts.length ? parts.join('\n') : null;
}
