/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings → Display. Navigation → SpaceMouse moved here from the Info
 * dialog's Preferences tab (#5509 put it there when no settings home
 * existed; #5857 is that home).
 */

import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Switch } from '@/components/ui/switch';
import { SpaceMousePanel } from '../SpaceMousePanel';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

export function DisplaySection() {
  const { t } = useTranslation();
  const showPerformanceStats = useViewerStore((s) => s.showPerformanceStats);
  const setShowPerformanceStats = useViewerStore((s) => s.setShowPerformanceStats);
  return (
    <div className="space-y-4">
      <SettingsGroup title={t('settings.display.performanceTitle')}>
        <SettingsRow
          label={t('settings.display.performanceStats')}
          hint={t('settings.display.performanceStatsHint')}
          htmlFor="settings-performance-stats"
        >
          <Switch
            id="settings-performance-stats"
            checked={showPerformanceStats}
            onCheckedChange={setShowPerformanceStats}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('settings.display.navigationTitle')}>
        <h4 className="mb-2 text-xs font-semibold">{t('settings.display.spaceMouseTitle')}</h4>
        <SpaceMousePanel />
      </SettingsGroup>
    </div>
  );
}
