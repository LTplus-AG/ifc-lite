/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { requiredModule } from './required-module';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { checkCatalogue, isCatalogueRecord } from '../catalogue-problems';
import { registerEnglish, registerLocale, setLocale, resolve, type Catalogue } from '../registry';
import { activateStartupLocale, createLocaleActivator, createLocaleChoice, LOCALE_STORAGE_KEY } from '../locale-activation';
import type { TranslationKey } from '../en';
import { messageParameters } from './message-parameters';
import { mergeEnglishEntries } from './merge-english';

async function allEnglish(): Promise<Catalogue> {
  const english: Catalogue = {};
  const dir = new URL('../catalogues/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.en.ts')).sort()) {
    const module: Record<string, unknown> = await import(new URL(file, dir).href);
    for (const value of Object.values(module)) {
      if (isCatalogueRecord(value)) mergeEnglishEntries(english, value, file);
    }
  }
  return english;
}

// Test-only registration; runtime locale discovery never imports this module.
export function catalogueContract(name: string, locale: string, loadCatalogue: () => Promise<Catalogue>,
  counts: readonly number[], exactBranches = false): void {
  test(`${name} shipping catalogue covers every current feature including lazy messages`, async () => {
    const catalogue = await requiredModule(loadCatalogue, `${name} shipping catalogue must be available`);
    const english = await allEnglish();
    registerEnglish(english);
    assert.deepEqual(Object.keys(catalogue).sort(), Object.keys(english).sort());
    assert.deepEqual(checkCatalogue(catalogue).problems, []);
    const exceptions: Record<string, { value: unknown; reason: string }> = JSON.parse(
      readFileSync(new URL(`../locales/${locale}-identical.json`, import.meta.url), 'utf8'));
    const identical = Object.keys(catalogue).filter(key => JSON.stringify(catalogue[key as TranslationKey])
      === JSON.stringify(english[key as keyof Catalogue])).sort();
    assert.deepEqual(Object.keys(exceptions).sort(), identical,
      `Review identical English/${name} messages and update explicit exceptions`);
    for (const key of identical) {
      assert.deepEqual(exceptions[key].value, catalogue[key as TranslationKey], key);
      assert.ok(exceptions[key].reason.length > 30, `${key}: explain the exception`);
    }
    for (const [key, message] of Object.entries(catalogue)) {
      for (const text of typeof message === 'string' ? [message] : Object.values(message)) {
        assert.ok(text.trim().length || (key === 'modelingCommand.unit.count' && english[key] === ''),
          `${key}: empty ${name} message`);
      }
    }
  });

  test(`${name} plural resolution preserves non-count context in selected cardinal categories`, async () => {
    const catalogue = await requiredModule(loadCatalogue, `${name} shipping catalogue must be available`);
    const english = await allEnglish();
    registerLocale(locale, catalogue);
    setLocale(locale);
    try {
      for (const [key, message] of Object.entries(english)) {
        if (typeof message === 'string') continue;
        for (const count of counts) {
          const category = new Intl.PluralRules(locale, { maximumSignificantDigits: 21 }).select(count);
          const translated = catalogue[key as TranslationKey];
          assert.ok(translated && typeof translated === 'object', `${key}: plural translation required`);
          if (exactBranches) assert.ok(Object.hasOwn(translated, category), `${key}: explicit ${category} branch`);
          const expected: string = translated[category] ?? translated.other;
          if (exactBranches) assert.deepEqual(messageParameters(expected),
            messageParameters(message[category] ?? message.other), `${key}: ${category} exact branch parameters`);
          const names: string[] = messageParameters(message).filter(name => name !== 'count');
          for (const name of names) assert.ok(expected.includes(`{${name}}`), `${key}: ${category} must preserve ${name}`);
          const params: Record<string, string> = Object.fromEntries(names.map(name => [name, `SENTINEL_${name}`]));
          const rendered = resolve(key as TranslationKey, { ...params, count });
          for (const name of names) assert.ok(rendered.includes(`SENTINEL_${name}`), `${key}, ${count}: ${name}`);
          assert.doesNotMatch(rendered, /\{[A-Za-z][A-Za-z0-9_]*\}/, key);
        }
      }
    } finally { setLocale('en'); }
  });

  test(`real ${name} catalogue negotiates ${locale}-CH, persists the Settings choice, reloads and returns to Auto`, async () => {
    const catalogue = await requiredModule(loadCatalogue, `${name} shipping catalogue must be available`);
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); } };
    const html = { lang: 'en' };
    const activate = () => createLocaleActivator({ [locale]: async () => catalogue }, html);
    try {
      assert.equal(await activateStartupLocale(activate(), { storage, languages: [`${locale}-CH`] }), locale);
      assert.equal(html.lang, locale);
      assert.equal(await createLocaleChoice(activate(), { storage, languages: ['en'] }).choose(locale), locale);
      assert.equal(stored.get(LOCALE_STORAGE_KEY), locale);
      assert.equal(await activateStartupLocale(activate(), { storage, languages: ['en'] }), locale);
      assert.equal(await createLocaleChoice(activate(), { storage, languages: ['en'] }).clear(), 'en');
      assert.equal(html.lang, 'en');
    } finally { setLocale('en'); }
  });
}
