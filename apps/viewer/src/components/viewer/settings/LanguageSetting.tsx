/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings → General → Language (#9061): the only way to pick the UI
 * language. A combobox lists "Auto" (follow the browser) and every locale the
 * viewer ships, each under its own name; adding `locales/<tag>.ts` adds an
 * entry. A choice is remembered on this browser and applies without a reload.
 */

import { useState } from 'react';
import { Globe } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { getLocaleChoice } from '@/i18n/locale-activation';
import { localeDisplayName } from '@/i18n/locale-names';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsRow } from './SettingsGroup';

const AUTO = 'auto';

export function LanguageSetting() {
  const { t, locale: uiLocale } = useTranslation();
  const choice = getLocaleChoice();
  const [value, setValue] = useState<string>(() => choice?.chosen() ?? AUTO);
  if (!choice) return null;

  const onChange = (next: string) => {
    setValue(next);
    const switched = next === AUTO ? choice.clear() : choice.choose(next);
    switched.catch((error: unknown) => {
      console.warn('[i18n] Could not switch the UI language.', error);
    });
  };

  // Ordered for the reader of the current UI, not the machine's default collation.
  const collator = new Intl.Collator(uiLocale);
  const locales = choice.available
    .map((locale) => ({ locale, name: localeDisplayName(locale) }))
    .sort((a, b) => collator.compare(a.name, b.name));

  return (
    <SettingsRow label={t('settings.general.language')} icon={<Globe className="h-4 w-4" />}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="settings-language" aria-label={t('settings.general.language')} className="h-8 w-56 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO} className="text-xs">{t('settings.general.languageAuto')}</SelectItem>
          {locales.map(({ locale, name }) => (
            <SelectItem key={locale} value={locale} lang={locale} className="text-xs">{name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
