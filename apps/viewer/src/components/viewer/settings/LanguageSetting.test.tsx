/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9061: Settings → General → Language is the one way to pick the UI language. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, click, render } from '@/test/render.js';
import { SettingsDialogHost } from './SettingsDialog';
import { openSettings } from '@/lib/settings/open-settings';
import { settingsEn } from '@/i18n/catalogues/settings.en';
import { createLocaleActivator, LOCALE_STORAGE_KEY, type LocaleChoice } from '@/i18n/locale-activation';
// Namespace import for the #9061 additions: with production reverted the file
// still loads and every test fails on an assertion, not at import.
import * as activation from '@/i18n/locale-activation';
import { getLocale, setLocale, type Catalogue } from '@/i18n/registry';

const GERMAN: Catalogue = { 'settings.general.language': 'Sprache', 'settings.general.languageAuto': 'Automatisch (Browsersprache)' };
const AUTO = settingsEn['settings.general.languageAuto'];

function installLocaleChoice(choice: LocaleChoice | null): void {
  const install: unknown = Reflect.get(activation, 'installLocaleChoice');
  if (typeof install === 'function') activation.installLocaleChoice(choice);
}

function install(languages: readonly string[]) {
  const values = new Map<string, string>();
  const storage = {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const loaders = { de: async () => GERMAN, fr: async () => ({}), ru: async () => ({}) };
  const create: unknown = Reflect.get(activation, 'createLocaleChoice');
  assert.equal(typeof create, 'function', 'Settings → Language needs createLocaleChoice (#9061)');
  installLocaleChoice(activation.createLocaleChoice(createLocaleActivator(loaders, document.documentElement), { storage, languages }));
  return storage;
}

function openGeneral(): HTMLElement {
  render(<SettingsDialogHost />);
  act(() => openSettings('general'));
  const trigger = document.querySelector<HTMLElement>('#settings-language');
  assert.ok(trigger, 'Settings → General shows the language combobox');
  assert.equal(trigger.getAttribute('role'), 'combobox');
  return trigger;
}

async function options(trigger: HTMLElement): Promise<HTMLElement[]> {
  click(trigger);
  await advance(0);
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
}

async function pick(trigger: HTMLElement, label: string): Promise<void> {
  const option = (await options(trigger)).find((o) => o.textContent === label);
  assert.ok(option, `a "${label}" option is listed`);
  click(option);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

afterEach(() => {
  cleanup();
  installLocaleChoice(null);
  setLocale('en');
  document.documentElement.lang = 'en';
});

describe('Settings → Language (#9061)', () => {
  it('lists Auto, then every shipped locale under its own name, with Auto selected when nothing is stored', async () => {
    install(['en']);
    const trigger = openGeneral();
    assert.equal(trigger.getAttribute('aria-label'), settingsEn['settings.general.language']);
    assert.equal(trigger.textContent, AUTO);
    const listed = await options(trigger);
    assert.deepEqual(listed.map((o) => o.textContent), [AUTO, 'Deutsch', 'English', 'Français', 'Русский']);
    assert.equal(listed.find((o) => o.textContent === 'Русский')?.getAttribute('lang'), 'ru');
  });

  it('switches the UI without a reload and remembers the choice; Auto forgets it', async () => {
    const storage = install(['en']);
    const trigger = openGeneral();

    await pick(trigger, 'Deutsch');
    assert.equal(getLocale(), 'de');
    assert.equal(document.documentElement.lang, 'de');
    assert.equal(storage.values.get(LOCALE_STORAGE_KEY), 'de');
    assert.equal(trigger.textContent, 'Deutsch');
    assert.equal(trigger.getAttribute('aria-label'), 'Sprache', 'the open dialog re-renders in German');

    await pick(trigger, 'Automatisch (Browsersprache)');
    assert.equal(storage.values.has(LOCALE_STORAGE_KEY), false);
    assert.equal(getLocale(), 'en', 'Auto follows the browser language again');
    assert.equal(trigger.textContent, AUTO);
  });

  it('shows the stored choice when the dialog opens', () => {
    const storage = install(['en']);
    storage.values.set(LOCALE_STORAGE_KEY, 'ru');
    assert.equal(openGeneral().textContent, 'Русский');
  });
});
