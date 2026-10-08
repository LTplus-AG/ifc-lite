/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Report narrative languages (#6918), chosen per draft and independent of the
 * viewer's UI language. Only Latin-script languages are offered: documents
 * print with the standard PDF fonts, which cover German and French fully and
 * transliterate the few Central European letters outside them (with a notice).
 */

export const REPORT_LANGUAGES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'pt', 'da', 'sv', 'nb', 'fi', 'pl', 'cs'] as const;
export type ReportLanguage = typeof REPORT_LANGUAGES[number];

export function isReportLanguage(value: unknown): value is ReportLanguage {
  return typeof value === 'string' && REPORT_LANGUAGES.some(language => language === value);
}

/** A language's name in `displayLocale`, falling back to its tag where Intl lacks names. */
export function reportLanguageName(language: string, displayLocale: string): string {
  try { return new Intl.DisplayNames([displayLocale], { type: 'language' }).of(language) ?? language; }
  catch (error) {
    console.debug('[Assistant report] Language names unavailable', error);
    return language;
  }
}

/** The UI language when it is a report language, else English. */
export function defaultReportLanguage(uiLocale: string): ReportLanguage {
  const base = uiLocale.split('-')[0].toLowerCase();
  return isReportLanguage(base) ? base : 'en';
}

/** Instruction sent with the request; the model-facing name is English so any provider understands it. */
export function reportLanguageInstruction(language: ReportLanguage): string {
  return `Write the narrative and every claim text in ${reportLanguageName(language, 'en')} (${language}); keep citations, field paths, units and native values exactly as captured.`;
}

/** True when the provider declared a different language than the one requested (region subtags ignored). */
export function declaredLanguageDiffers(declared: string | null, chosen: ReportLanguage): boolean {
  return declared !== null && declared.split('-')[0].toLowerCase() !== chosen;
}
