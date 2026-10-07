/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Assistant's generation language, kept apart from the UI locale (#6926).
 *
 * The UI locale (`i18n/registry`) drives chrome strings. Generated answers can
 * use a different language the user picks; each conversation records both the
 * UI locale it started under and the generation language it asks for, and the
 * saved conversation carries them. Source values (element and property names,
 * values, IFC classes, GlobalIds, quoted evidence) keep their original spelling
 * whatever the language.
 */

import { create } from 'zustand';
import { getLocale } from '@/i18n';

/** Languages offered in the picker. Any valid tag already stored is still honoured. */
export const GENERATION_LANGUAGES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'pt', 'pl', 'cs', 'sv', 'da', 'fi', 'nb', 'ja', 'zh', 'ko'] as const;

const STORAGE_KEY = 'ifc-lite:assistant-generation-language-v1';

export interface ConversationLanguage {
  /** UI locale active when the conversation started. Informational. */
  ui: string;
  /** Language the model is asked to write in. */
  generation: string;
}

export function isLanguageTag(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 35) return false;
  try { return Intl.getCanonicalLocales(value).length === 1; }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    console.debug('[Assistant] Ignoring an invalid stored language tag');
    return false;
  }
}

/** `de-CH` → `de`; the generation picker works on base languages. */
export function baseLanguage(locale: string): string {
  const base = locale.split('-')[0]?.toLowerCase() ?? 'en';
  return isLanguageTag(base) ? base : 'en';
}

function loadPreference(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLanguageTag(stored) ? stored : null;
  } catch (error) {
    console.warn('[assistant] ignoring unreadable generation language:', error);
    return null;
  }
}

/** `null` follows the UI locale. */
export const useGenerationLanguagePreference = create<{ language: string | null }>(() => ({ language: loadPreference() }));

export function setGenerationLanguagePreference(language: string | null): void {
  if (language !== null && !isLanguageTag(language)) return;
  useGenerationLanguagePreference.setState({ language });
  try {
    if (language === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, language);
  } catch (error) {
    console.warn('[assistant] failed to persist generation language:', error);
  }
}

/** The pair a new conversation records: the current UI locale and the preferred generation language. */
export function currentConversationLanguage(): ConversationLanguage {
  const ui = getLocale();
  return { ui, generation: useGenerationLanguagePreference.getState().language ?? baseLanguage(ui) };
}

/** A language's name in `displayLocale`, falling back to the tag itself. */
export function languageName(tag: string, displayLocale: string): string {
  try {
    return new Intl.DisplayNames([displayLocale, 'en'], { type: 'language' }).of(tag) ?? tag;
  } catch (error) {
    console.debug('[assistant] no display name for language', tag, error);
    return tag;
  }
}

/** System-prompt line for the generation language. Source values are never translated. */
export function generationLanguageInstruction(language: ConversationLanguage): string {
  const tag = isLanguageTag(language.generation) ? language.generation : 'en';
  return `Write explanations in ${languageName(tag, 'en')} (${tag}). Keep source values exactly as captured: element, type, material, property and set names, property values, IFC class names, GlobalIds, file names and quoted evidence keep their original spelling and are never translated or transliterated. Typed JSON proposals keep their specified keys and kinds.`;
}

export function decodeConversationLanguage(value: unknown): ConversationLanguage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { ui, generation } = value as Record<string, unknown>;
  return isLanguageTag(ui) && isLanguageTag(generation) ? { ui, generation } : undefined;
}
