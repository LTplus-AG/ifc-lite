/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings → General (#5857): theme and hover tooltips.
 */

import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { ThemeMode } from '@/store/slices/uiSlice';
import { Switch } from '@/components/ui/switch';
import { SettingsChoice, SettingsGroup, SettingsRow } from './SettingsGroup';

export function GeneralSection() {
  const { t } = useTranslation();
  const theme = useViewerStore((s) => s.theme);
  const setTheme = useViewerStore((s) => s.setTheme);
  const hoverTooltipsEnabled = useViewerStore((s) => s.hoverTooltipsEnabled);
  const toggleHoverTooltips = useViewerStore((s) => s.toggleHoverTooltips);

  return (
    <div className="space-y-4">
      <SettingsGroup title={t('settings.general.appearanceTitle')}>
        <SettingsRow label={t('settings.general.theme')}>
          <SettingsChoice<ThemeMode>
            id="settings-theme"
            label={t('settings.general.theme')}
            value={theme}
            options={[
              { value: 'light', label: t('settings.general.themeLight') },
              { value: 'dark', label: t('settings.general.themeDark') },
            ]}
            onChange={setTheme}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('settings.general.helpersTitle')}>
        <SettingsRow
          label={t('settings.general.hoverTooltips')}
          hint={t('settings.general.hoverTooltipsHint')}
          htmlFor="settings-hover-tooltips"
        >
          <Switch
            id="settings-hover-tooltips"
            checked={hoverTooltipsEnabled}
            onCheckedChange={() => toggleHoverTooltips()}
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
