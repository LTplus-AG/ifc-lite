/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Translator-facing catalogue checks (#4785). A contributed locale is data,
 * not code, so the mistakes it can make are data mistakes: a key that no
 * longer exists, a `{placeholder}` renamed or dropped, a plural message with
 * no `other` form. The locale-file test fails on them, and at runtime the
 * activator logs them and drops the broken messages, so those keys fall back
 * to English instead of rendering `{modelName}` literally.
 */
import { en, type TranslationKey } from './en';
import type { Catalogue } from './registry';
import type { TranslationValue } from './types';

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function placeholders(value: TranslationValue): Set<string> {
  const names = new Set<string>();
  const forms = typeof value === 'string' ? [value] : Object.values(value);
  for (const form of forms) {
    if (typeof form !== 'string') continue;
    for (const match of form.matchAll(PLACEHOLDER)) names.add(match[1]);
  }
  return names;
}

function isTranslationKey(key: string): key is TranslationKey {
  return Object.hasOwn(en, key);
}

function shapeProblem(value: unknown): string | null {
  if (typeof value === 'string') return null;
  if (!isRecord(value)) return 'must be a string or a plural object';
  if (typeof (Object.hasOwn(value, 'other') ? value.other : undefined) !== 'string') {
    return 'plural message has no "other" form';
  }
  const bad = Object.entries(value).find(([, form]) => typeof form !== 'string');
  return bad ? `plural form "${bad[0]}" must be a string` : null;
}

function isTranslationValue(value: unknown): value is TranslationValue {
  return shapeProblem(value) === null;
}

export interface CheckedCatalogue {
  /** The messages that passed every check. */
  catalogue: Catalogue;
  /** One line per rejected or suspect message, `<key>: <problem>`. */
  problems: string[];
}

/** Split untrusted catalogue data into usable messages and problems. */
export function checkCatalogue(raw: Readonly<Record<string, unknown>>): CheckedCatalogue {
  const catalogue: Catalogue = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isTranslationKey(key)) {
      problems.push(`${key}: not an English catalogue key`);
      continue;
    }
    if (!isTranslationValue(value)) {
      problems.push(`${key}: ${shapeProblem(value)}`);
      continue;
    }
    const message = value;
    const expected = placeholders(en[key]);
    const actual = placeholders(message);
    const before = problems.length;
    for (const name of actual) {
      if (!expected.has(name)) problems.push(`${key}: unknown placeholder {${name}}`);
    }
    for (const name of expected) {
      if (!actual.has(name)) problems.push(`${key}: missing placeholder {${name}}`);
    }
    if (problems.length === before) catalogue[key] = message;
  }
  return { catalogue, problems };
}

export function isCatalogueRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
